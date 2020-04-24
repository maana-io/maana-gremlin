import { log, print } from 'io.maana.shared'
import { gql } from 'apollo-server-express'
import uuid from 'uuid'
import _ from 'lodash'
import Gremlin from 'gremlin'
import crypto from 'crypto'
require('dotenv').config()

const config = {
  endpoint: process.env.GREMLIN_ENDPOINT,
  database: process.env.GREMLIN_DATABASE,
  collection: process.env.GREMLIN_COLLECTION,
  primaryKey: process.env.GREMLIN_PRIMARY_KEY
}

const authenticator = new Gremlin.driver.auth.PlainTextSaslAuthenticator(
  `/dbs/${config.database}/colls/${config.collection}`,
  config.primaryKey
)

const client = new Gremlin.driver.Client(config.endpoint, {
  authenticator,
  traversalsource: 'g',
  rejectUnauthorized: true,
  mimeType: 'application/vnd.gremlin-v2.0+json'
})

const SERVICE_ID = process.env.SERVICE_ID
const SELF = SERVICE_ID || 'io.maana.template'

// dummy in-memory store

const persistNode = async ({ id, label, payload, graph }) => {  
  const nodev = {
    id,
    label,
    payload,
    graph
  }

  const result = await client.submit(
    "g.V().has('id' ,id).fold().coalesce(unfold(),addV(label).property('id', id).property('payload', payload).property('graph', graph).property('partitionKey', 'partitionKey'))",
    nodev
  )

  const node = _.first(result._items)
  return node?.id
}

const persistEdge = async ({ id, from, to, payload, relation, graph }) => {
  const edgeV = {
    id,
    from,
    to,
    relation,
    payload,
    graph
  }
  const result = await client.submit(
    "g.E().has('id', id).fold().coalesce(unfold(),g.V(from).addE(relation).property('id', id).property('payload', payload).property('graph', graph).to(g.V(to)))",
    edgeV
  )

  const edge = _.first(result._items)
  return edge?.id
}

const getNode = async ({ id }) => {
  const result = await client.submit('g.V(id)', { id })
  const rawNode = result._items[0]

  console.log(result)
  return {
    id: rawNode.id,
    label: rawNode.label,
    payload: rawNode.properties.payload[0].value,
    graph: rawNode.properties.graph[0].value
  }
}

const getEdge = async ({ id }) => {
  const result = await client.submit('g.E(id)', { id })
  const rawEdge = result._items[0]

  return {
    id: rawEdge.id,
    label: rawEdge.label,
    from: rawEdge.outV,
    to: rawEdge.inV,
    payload: rawEdge.properties.payload[0].value,
    graph: rawEdge.properties.graph[0].value
  }
}

export const resolver = {
  Query: {
    info: async (_, args, { client }) => {
      let remoteId = SERVICE_ID

      try {
        if (client) {
          const query = gql`
            query info {
              info {
                id
              }
            }
          `
          const {
            data: {
              info: { id }
            }
          } = await client.query({ query })
          remoteId = id
        }
      } catch (e) {
        log(SELF).error(
          `Info Resolver failed with Exception: ${e.message}\n${print.external(
            e.stack
          )}`
        )
      }

      return {
        id: SERVICE_ID,
        name: 'io.maana.template',
        description: `Maana Q Knowledge Service template using ${remoteId}`
      }
    },
    graph: async _ => {
      const rawNodes = await client.submit('g.V()')
      const rawEdges = await client.submit('g.E()')
      const nodes = rawNodes._items.map(rawNode => {
        return {
          id: rawNode.id,
          label: rawNode.label,
          payload: rawNode.properties.payload[0].value,
          graph: rawNode.properties.graph[0].value
        }
      })      
      const edges = rawEdges._items.map(rawEdge => {
        return {
          id: rawEdge.id,
          relation: rawEdge.label,
          from: rawEdge.outV,
          to: rawEdge.inV,
          payload: rawEdge.properties.payload[0].value,
          graph: rawEdge.properties.graph[0].value
        }
      })

      return {
        id: uuid(),
        nodes,
        edges
      }
    },
    node: async (_, { id }) => getNode({ id }),
    nodes: async (_, { ids }) => Promise.all(ids.map(id => getNode({ id }))),
    edge: async (_, { id }) => getEdge({ id }),
    edges: async (_, { ids }) => Promise.all(ids.map(id => getEdge({ id }))),
    nodeOutgoingConnections: async (_, { node, relation }) => {
      const query = relation ? `g.V("${node}").outE("${relation}")` : `g.V("${node}").outE()`

      const result = await client.submit(query)
      
      const nodes = await Promise.all(result._items.map(entry => getNode({id: entry.inV})))
      const edges = result._items.map(entry => ({
        id: entry.id,
        from: entry.outV,
        to: entry.inV,
        relation: entry.label,
        payload: null, 
        graph: entry.properties.graph
      }))

      return {
        id: nodes[0].graph,
        nodes,
        edges
      }
    },
    nodeIncomingConnections: async (_, { node, relation }) => {
      const query = relation ? `g.V("${node}").inE("${relation}")` : `g.V("${node}").inE()`
      const result = await client.submit(query)
      const nodes = await Promise.all(result._items.map(entry => getNode({id: entry.outV})))
      const edges = result._items.map(entry => ({
        id: entry.id,
        from: entry.inV,
        to: entry.outV,
        relation: entry.label,
        payload: null, 
        graph: entry.properties.graph
      }))

      return {
        id: nodes[0].graph,
        nodes,
        edges
      }
    },
    shortestPath: async (_, { startNode, endNode }) => {
      const result = await client.submit(
        'g.V(startNode).repeat(out().simplePath()).until(hasId(endNode)).path().group().by(count(local))',
        { startNode, endNode }
      )
      return JSON.stringify(result)
    }
  },
  Mutation: {
    persistNode: async (_, { node }) => persistNode({ ...node }),
    persistNodes: async (_, { nodes }) => {
      const result = await Promise.all(
        nodes.map(node => persistNode({ ...node }))
      )
      return result.filter(x => x)
    },
    persistEdge: async (_, { edge }) => persistEdge({ ...edge }),
    persistEdges: async (_, { edges }) => {
      const result = await Promise.all(
        edges.map(edge => persistEdge({ ...edge }))
      )      
      return result.filter(x => x)
    },
    persistGraph: async (_, { graph }) => {
      await Promise.all(graph.nodes.map(node => persistNode({ ...node })))
      setTimeout(async () => {
        await Promise.all(graph.edges.map(edge => persistEdge({ ...edge })))
      }, 1000)

      return graph.id
    }
  }
}
