// Run with Node 22.13+: node scripts/test-database-browser.cjs
// Exercise the service's generated SQL against real SQLite, without opening user data.
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, symlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { build } = require('esbuild')

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'wememo-browser-test-'))
  let accountDir = join(root, 'account')
  mkdirSync(join(accountDir, 'db_storage', 'message'), { recursive: true })
  const database = 'db_storage/message/message_0.db'
  const path = join(accountDir, database)
  const db = new DatabaseSync(path)
  const statements = []
  let tableCalls = 0
  let failListing = false
  let failQuery = false
  const weirdTable = 'a"; DROP TABLE records;--'
  const quote = name => '"' + name.replace(/"/g, '""') + '"'
  try {
    db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, content TEXT, nullable TEXT, payload BLOB); CREATE TABLE empty_table(name TEXT); CREATE TABLE no_pk(value TEXT); CREATE TABLE composite(a INTEGER, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID;')
    db.exec('CREATE TABLE ' + quote(weirdTable) + '("strange""column" TEXT)')
    db.prepare('INSERT INTO ' + quote(weirdTable) + ' VALUES (?)').run('safe')
    const insert = db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)')
    for (let id = 1; id <= 125; id++) insert.run(id, id === 7 ? "O'Reilly 100%_ 中文" : 'record ' + id, null, Buffer.from([0, 1, 255]))
    db.exec("INSERT INTO no_pk VALUES ('b'), ('a'); INSERT INTO composite VALUES (2,1),(1,2),(1,1)")
    const mocks = {
      './config': { ConfigService: class {
        get() { return root }
        getMyWxidCleaned() { return 'account' }
        getAccountDir() { return accountDir }
      } },
      './chatService': { chatService: { connect: async () => ({ success: true }) } },
      './wcdbService': { wcdbService: {
        listTables: async () => {
          tableCalls++
          return failListing ? { success: false } : { success: true, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name) }
        },
        execQuery: async (_kind, _path, sql) => {
          statements.push(sql)
          if (failQuery) return { success: false, error: 'fixture query failure' }
          try { return { success: true, rows: db.prepare(sql).all() } }
          catch (error) { return { success: false, error: error.message } }
        }
      } }
    }
    const compiled = await build({
      entryPoints: [resolve(__dirname, '../electron/services/databaseBrowserService.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false,
      plugins: [{ name: 'fixture-dependencies', setup(builder) {
        builder.onResolve({ filter: /^\.\/(config|chatService|wcdbService)$/ }, args => ({ path: args.path, external: true }))
      } }]
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(id => mocks[id] || require(id), module, module.exports)
    const service = new module.exports.DatabaseBrowserService()
    const catalog = await service.inspect()
    assert.equal(catalog.success, true)
    assert.equal(catalog.data.databases[0].relativePath, database)
    assert.equal(tableCalls, 0, 'catalog must not eagerly query table lists')
    assert.equal(statements.length, 0, 'catalog must not run statistics queries')

    const read = options => service.readTable({ database, table: 'records', ...options })
    const first = await read({})
    assert.equal(first.success, true)
    assert.equal(first.data.rows.length, 50)
    assert.equal(first.data.rows[0].id, 1)
    assert.equal(first.data.hasMore, true)
    assert.equal(first.data.columns[0].primaryKey, 1)
    assert.equal(first.data.rows[0].nullable, null)
    assert.deepEqual([...first.data.rows[0].payload], [0, 1, 255])
    const second = await read({ offset: 50 })
    assert.equal(second.data.rows[0].id, 51)
    const last = await read({ offset: 100 })
    assert.equal(last.data.rows.length, 25)
    assert.equal(last.data.hasMore, false)
    assert.equal((await read({ limit: 200 })).data.rows.length, 125)
    assert.equal((await read({ sortColumn: 'id', sortDirection: 'desc' })).data.rows[0].id, 125)
    for (const search of ["O'Reilly", '100%_', '中文']) {
      const result = await read({ search })
      assert.equal(result.success, true)
      assert.equal(result.data.rows.length, 1)
      assert.equal(result.data.rows[0].id, 7)
    }
    assert.equal((await read({ search: "' OR 1=1 --" })).data.rows.length, 0)
    assert.equal((await read({ table: weirdTable })).data.rows[0]['strange"column'], 'safe')
    const empty = await read({ table: 'empty_table' })
    assert.equal(empty.data.rows.length, 0)
    assert.equal(empty.data.columns[0].name, 'name')
    assert.equal((await read({ table: 'no_pk' })).data.rows[0].value, 'b')
    assert.equal((await read({ table: 'composite' })).data.rows[0].b, 1)
    for (const invalid of [{ limit: 201 }, { offset: -1 }, { offset: NaN }, { sortColumn: 'id; DROP TABLE records' }, { table: 'not_found' }, { search: '\0' }, { search: 'x'.repeat(501) }, { sortDirection: 'sideways' }]) {
      assert.equal((await read(invalid)).success, false, JSON.stringify(invalid))
    }
    assert.equal((await service.readTable(null)).success, false)
    assert.equal((await read({ database: 'db_storage/message/../../db_storage/message/message_0.db' })).success, false)
    symlinkSync(path, join(accountDir, 'db_storage/message/alias.db'))
    assert.equal((await read({ database: 'db_storage/message/alias.db' })).success, false)
    const secondAccount = join(root, 'second-account')
    mkdirSync(secondAccount)
    accountDir = secondAccount
    assert.equal((await read({ database: '../account/' + database })).success, false, 'cannot read previous account')
    accountDir = join(root, 'account')
    failListing = true
    assert.equal((await service.tables(database)).success, true, 'sqlite_master fallback')
    failQuery = true
    assert.equal((await read({})).success, false, 'query errors must not look like empty tables')
    assert.ok(statements.every(sql => /^(SELECT|PRAGMA table_info)/.test(sql)))
    assert.ok(statements.every(sql => !/COUNT\s*\(/i.test(sql)))
    console.log('PASS: catalog, lazy tables, pagination, sorting, filtering, quoted identifiers, empty tables, schema, NULL/BLOB, invalid input, path/account isolation, errors and read-only SQL')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
