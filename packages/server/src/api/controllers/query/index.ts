import { generateQueryID, getQueryParams, isProdAppID } from "../../../db/utils"
import { BaseQueryVerbs } from "../../../constants"
import { Thread, ThreadType } from "../../../threads"
import { save as saveDatasource } from "../datasource"
import { RestImporter } from "./import"
import { invalidateDynamicVariables } from "../../../threads/utils"
import { QUERY_THREAD_TIMEOUT } from "../../../environment"
import { getAppDB } from "@budibase/backend-core/context"
import { quotas } from "@budibase/pro"
import { events } from "@budibase/backend-core"

const Runner = new Thread(ThreadType.QUERY, {
  timeoutMs: QUERY_THREAD_TIMEOUT || 10000,
})

// simple function to append "readable" to all read queries
function enrichQueries(input: any) {
  const wasArray = Array.isArray(input)
  const queries = wasArray ? input : [input]
  for (let query of queries) {
    if (query.queryVerb === BaseQueryVerbs.READ) {
      query.readable = true
    }
  }
  return wasArray ? queries : queries[0]
}

export async function fetch(ctx: any) {
  const db = getAppDB()

  const body = await db.allDocs(
    getQueryParams(null, {
      include_docs: true,
    })
  )

  ctx.body = enrichQueries(body.rows.map((row: any) => row.doc))
}

const _import = async (ctx: any) => {
  const body = ctx.request.body
  const data = body.data

  const importer = new RestImporter(data)
  await importer.init()

  let datasourceId
  if (!body.datasourceId) {
    // construct new datasource
    const info: any = await importer.getInfo()
    let datasource = {
      type: "datasource",
      source: "REST",
      config: {
        url: info.url,
        defaultHeaders: [],
      },
      name: info.name,
    }
    // save the datasource
    const datasourceCtx = { ...ctx }
    datasourceCtx.request.body.datasource = datasource
    await saveDatasource(datasourceCtx)
    datasourceId = datasourceCtx.body.datasource._id
  } else {
    // use existing datasource
    datasourceId = body.datasourceId
  }

  const importResult = await importer.importQueries(datasourceId)

  ctx.body = {
    ...importResult,
    datasourceId,
  }
  ctx.status = 200
}
export { _import as import }

export async function save(ctx: any) {
  const db = getAppDB()
  const query = ctx.request.body

  const datasource = await db.get(query.datasourceId)

  let eventFn
  if (!query._id) {
    query._id = generateQueryID(query.datasourceId)
    eventFn = () => events.query.created(datasource, query)
  } else {
    eventFn = () => events.query.updated(datasource, query)
  }

  const response = await db.put(query)
  await eventFn()
  query._rev = response.rev

  ctx.body = query
  ctx.message = `Query ${query.name} saved successfully.`
}

export async function find(ctx: any) {
  const db = getAppDB()
  const query = enrichQueries(await db.get(ctx.params.queryId))
  // remove properties that could be dangerous in real app
  if (isProdAppID(ctx.appId)) {
    delete query.fields
    delete query.parameters
  }
  ctx.body = query
}

export async function preview(ctx: any) {
  const db = getAppDB()

  const datasource = await db.get(ctx.request.body.datasourceId)
  const query = ctx.request.body
  // preview may not have a queryId as it hasn't been saved, but if it does
  // this stops dynamic variables from calling the same query
  const { fields, parameters, queryVerb, transformer, queryId } = query

  try {
    const runFn = () =>
      Runner.run({
        appId: ctx.appId,
        datasource,
        queryVerb,
        fields,
        parameters,
        transformer,
        queryId,
      })

    const { rows, keys, info, extra } = await quotas.addQuery(runFn)
    await events.query.previewed(datasource, query)
    ctx.body = {
      rows,
      schemaFields: [...new Set(keys)],
      info,
      extra,
    }
  } catch (err) {
    ctx.throw(400, err)
  }
}

async function execute(ctx: any, opts = { rowsOnly: false }) {
  const db = getAppDB()

  const query = await db.get(ctx.params.queryId)
  const datasource = await db.get(query.datasourceId)

  const enrichedParameters = ctx.request.body.parameters || {}
  // make sure parameters are fully enriched with defaults
  if (query && query.parameters) {
    for (let parameter of query.parameters) {
      if (!enrichedParameters[parameter.name]) {
        enrichedParameters[parameter.name] = parameter.default
      }
    }
  }

  // call the relevant CRUD method on the integration class
  try {
    const runFn = () =>
      Runner.run({
        appId: ctx.appId,
        datasource,
        queryVerb: query.queryVerb,
        fields: query.fields,
        pagination: ctx.request.body.pagination,
        parameters: enrichedParameters,
        transformer: query.transformer,
        queryId: ctx.params.queryId,
      })

    const { rows, pagination, extra } = await quotas.addQuery(runFn)
    if (opts && opts.rowsOnly) {
      ctx.body = rows
    } else {
      ctx.body = { data: rows, pagination, ...extra }
    }
  } catch (err) {
    ctx.throw(400, err)
  }
}

export async function executeV1(ctx: any) {
  return execute(ctx, { rowsOnly: true })
}

export async function executeV2(ctx: any) {
  return execute(ctx, { rowsOnly: false })
}

const removeDynamicVariables = async (queryId: any) => {
  const db = getAppDB()
  const query = await db.get(queryId)
  const datasource = await db.get(query.datasourceId)
  const dynamicVariables = datasource.config.dynamicVariables

  if (dynamicVariables) {
    // delete dynamic variables from the datasource
    datasource.config.dynamicVariables = dynamicVariables.filter(
      (dv: any) => dv.queryId !== queryId
    )
    await db.put(datasource)

    // invalidate the deleted variables
    const variablesToDelete = dynamicVariables.filter(
      (dv: any) => dv.queryId === queryId
    )
    await invalidateDynamicVariables(variablesToDelete)
  }
}

export async function destroy(ctx: any) {
  const db = getAppDB()
  const queryId = ctx.params.queryId
  await removeDynamicVariables(queryId)
  const query = await db.get(queryId)
  const datasource = await db.get(query.datasourceId)
  await db.remove(ctx.params.queryId, ctx.params.revId)
  ctx.message = `Query deleted.`
  ctx.status = 200
  await events.query.deleted(datasource, query)
}
