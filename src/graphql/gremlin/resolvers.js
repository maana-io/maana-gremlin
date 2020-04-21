import { log, print } from 'io.maana.shared'
import { gql } from 'apollo-server-express'
import uuid from 'uuid'
import _ from 'lodash'
import Gremlin from 'gremlin'
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
  const result = await client.submit(
    "g.V().has('id' ,id).fold().coalesce(unfold(),addV(label).property('id', id).property('payload', payload).property('graph', graph).property('partitionKey', 'partitionKey'))",
    {
      id,
      label,
      payload,
      graph
    }
  )

  const node = _.first(result._items)
  return node.id
}

const persistEdge = async ({ id, from, to, payload, relation, graph }) => {
  const result = await client.submit(
    "g.E().has('id', id).fold().coalesce(unfold(),g.V(from).addE(relation).property('id', id).property('payload', payload).property('graph', graph).to(g.V(to)))",
    {
      id,
      from,
      to,
      relation,
      payload,
      graph
    }
  )
  const edge = _.first(result._items)
  return edge.id
}

const getNode = async ({ id }) => {
  const result = await client.submit('g.V(id)', { id })
  const rawNode = result._items[0]
  return {
    id: rawNode.id,
    label: rawNode.label,
    payload: rawNode.properties.payload[0],
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
    payload: rawEdge.properties.payload,
    graph: rawEdge.properties.graph
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
          payload: rawNode.properties.payload[0],
          graph: rawNode.properties.graph[0]
        }
      })

      const edges = rawEdges._items.map(rawEdge => {
        console.log(rawEdge)
        return {
          id: rawEdge.id,
          label: rawEdge.label,
          from: rawEdge.outV,
          to: rawEdge.inV,
          payload: rawEdge.properties.payload[0],
          graph: rawEdge.properties.graph[0]
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
    edges: async (_, { ids }) => Promise.all(ids.map(id => getEdge({ id })))
  },
  Mutation: {
    persistNode: async (_, { id, label, payload, graph }) =>
      persistNode({ id, label, payload, graph }),
    persistNodes: async (_, { nodes }) => {
      const result = await Promise.all(
        nodes.map(node => persistNode({ ...node }))
      )
      return result
    },
    persistEdge: async (_, { id, from, to, payload, relation, graph }) =>
      persistEdge({ id, from, to, payload, relation, graph }),
    persistEdges: async (_, { edges }) => {
      const result = await Promise.all(
        edges.map(edge => persistEdge({ ...edge }))
      )
      return result
    }
  }
}
