import { connect } from './helpers.mjs'

const { call, edit, check, docs, scratch, finish } = await connect()
const LOGO = 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png'
const LOGO_SMALL = 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png'

const documentId = await scratch('<p>intro line</p><p>middle line</p><p>closing line</p>')
console.log('scratch doc', documentId)
const raw = async () => (await docs.documents.get({ documentId })).data
const firstTable = async () => (await raw()).body.content.find(el => el.table)?.table

let read = await call('read_doc', { documentId })
const firstRevision = /revisionId: (\S+)/.exec(read.text)[1]
check('read_doc shows tab and page setup', /\ntab: t\.0 /.test(read.text) && /\npage: [\d.]+x[\d.]+pt, margins top/.test(read.text), read.text.slice(0, 300))

// Page setup
let res = await edit('set_page_setup', { documentId })
check('red: page setup with nothing is refused', res.error && /Nothing to set/.test(res.text), res.text)
res = await edit('set_page_setup', { documentId, pageWidth: 500 })
check('red: width without height is refused', res.error && /together/.test(res.text), res.text)
res = await edit('set_page_setup', { documentId, marginTop: 36, marginBottom: 36, marginLeft: 36, marginRight: 36, pageSize: 'A4', orientation: 'landscape' })
read = await call('read_doc', { documentId })
check('page setup: A4 landscape with 36pt margins', !res.error && /page: 841\.89x595\.28pt, margins top 36 bottom 36 left 36 right 36\n/.test(read.text), res.text + '\n' + read.text.slice(0, 300))
res = await edit('set_page_setup', { documentId, orientation: 'portrait' })
read = await call('read_doc', { documentId })
check('page setup: orientation alone flips the current size', !res.error && /page: 595\.28x841\.89pt/.test(read.text), res.text + '\n' + read.text.slice(0, 300))
res = await edit('set_page_setup', { documentId, marginTop: 50, revisionId: firstRevision })
check('red: stale revisionId is refused', res.error && /changed since/.test(res.text), res.text)

// Tables
res = await edit('edit_table', { documentId, table: 1, action: 'delete_row', row: 1, column: 1 })
check('red: missing table is refused', res.error && /No table 1/.test(res.text), res.text)
res = await edit('insert_table', { documentId, rows: 2, columns: 2, cells: [['a1', 'b1'], ['a2', 'b2']] })
read = await call('read_doc', { documentId })
check('insert_table fills its cells', !res.error && /table 1 \[\d+-\d+\] 2 rows x 2 columns/.test(read.text) && /r1c1 \[\d+-\d+\] "a1\\n"/.test(read.text) && /r2c2 \[\d+-\d+\] "b2\\n"/.test(read.text), res.text + '\n' + read.text)
res = await edit('set_table_cell_text', { documentId, table: 1, row: 9, column: 1, text: 'x' })
check('red: missing cell is refused', res.error && /No cell at row 9/.test(res.text), res.text)
res = await edit('edit_table', { documentId, table: 1, action: 'insert_row', row: 1, column: 1 })
let res2 = await edit('edit_table', { documentId, table: 1, action: 'insert_column', row: 1, column: 2 })
let table = await firstTable()
check('insert_row and insert_column grow the table to 3x3', !res.error && !res2.error && table.rows === 3 && table.columns === 3, res.text + res2.text)
res = await edit('set_table_cell_text', { documentId, table: 1, row: 2, column: 1, text: 'new' })
res2 = await edit('set_table_cell_text', { documentId, table: 1, row: 1, column: 1, text: 'first' })
read = await call('read_doc', { documentId })
check('set_table_cell_text fills an empty cell and replaces a full one', !res.error && !res2.error && /r2c1 \[\d+-\d+\] "new\\n"/.test(read.text) && /r1c1 \[\d+-\d+\] "first\\n"/.test(read.text) && /r3c1 \[\d+-\d+\] "a2\\n"/.test(read.text), res.text + res2.text + '\n' + read.text)
res = await edit('format_text', { documentId, find: 'first', bold: true })
read = await call('read_doc', { documentId })
check('find reaches text inside a table', !res.error && /"first\\n" \{bold\}/.test(read.text) && !/"b1\\n" \{bold/.test(read.text), res.text)
res = await edit('edit_table', { documentId, table: 1, action: 'merge_cells', row: 1, column: 1, columnSpan: 2 })
table = await firstTable()
check('merge_cells spans two columns', !res.error && table.tableRows[0].tableCells[0].tableCellStyle.columnSpan === 2, res.text)
res = await edit('edit_table', { documentId, table: 1, action: 'unmerge_cells', row: 1, column: 1, columnSpan: 2 })
table = await firstTable()
check('unmerge_cells restores the span', !res.error && table.tableRows[0].tableCells[0].tableCellStyle.columnSpan === 1, res.text)
res = await edit('edit_table', { documentId, table: 1, action: 'delete_column', row: 1, column: 3 })
res2 = await edit('edit_table', { documentId, table: 1, action: 'delete_row', row: 2, column: 1 })
table = await firstTable()
check('delete_column and delete_row shrink it to 2x2', !res.error && !res2.error && table.rows === 2 && table.columns === 2, res.text + res2.text)
res = await edit('edit_table', { documentId, table: 1, action: 'set_column_width', column: 1, width: 100 })
table = await firstTable()
check('set_column_width fixes column 1 at 100pt', !res.error && table.tableStyle.tableColumnProperties[0].width?.magnitude === 100, res.text + JSON.stringify(table.tableStyle))
res = await edit('style_table_cells', { documentId, table: 1 })
check('red: cell style with nothing is refused', res.error && /No style given/.test(res.text), res.text)
res = await edit('style_table_cells', { documentId, table: 1, row: 1, column: 1, backgroundColor: '#ffff00', padding: 4, verticalAlignment: 'MIDDLE' })
res2 = await edit('style_table_cells', { documentId, table: 1, borderWidth: 0 })
table = await firstTable()
let cellStyle = table.tableRows[0].tableCells[0].tableCellStyle
let otherStyle = table.tableRows[1].tableCells[1].tableCellStyle
check('style_table_cells: one cell filled, padded, middle-aligned', !res.error && cellStyle.backgroundColor?.color?.rgbColor?.red === 1 && cellStyle.paddingTop?.magnitude === 4 && cellStyle.contentAlignment === 'MIDDLE' && !otherStyle.backgroundColor?.color, res.text + JSON.stringify(cellStyle))
check('style_table_cells: whole table borders hidden', !res2.error && (otherStyle.borderTop?.width?.magnitude ?? 0) === 0 && (cellStyle.borderLeft?.width?.magnitude ?? 0) === 0, res2.text + JSON.stringify(otherStyle))

// Protected text inside a table
await edit('format_text', { documentId, find: 'a2', italic: true })
res = await edit('set_table_cell_text', { documentId, table: 1, row: 2, column: 1, text: 'x' })
res2 = await edit('edit_table', { documentId, table: 1, action: 'delete_row', row: 2, column: 1 })
let res3 = await edit('edit_table', { documentId, table: 1, action: 'delete_column', row: 1, column: 1 })
read = await call('read_doc', { documentId })
check('red: overwriting or deleting a protected cell is refused', res.error && res2.error && res3.error && [res, res2, res3].every(reply => /protected \(italic\)/.test(reply.text)) && /r2c1 \[\d+-\d+\] "a2\\n"/.test(read.text), res.text + res2.text + res3.text)
check('read_doc lists the protected cell text', /--- PROTECTED ---\n\[\d+-\d+\] "a2/.test(read.text), read.text.slice(0, 500))

// Images
res = await edit('insert_image', { documentId, uri: LOGO, width: 60 })
check('red: width without height is refused', res.error && /together/.test(res.text), res.text)
res = await edit('insert_image', { documentId, uri: LOGO, width: 60, height: 20 })
read = await call('read_doc', { documentId })
const imageId = /Inserted image (\S+)\./.exec(res.text)?.[1]
check('insert_image adds a 60x20pt image', !res.error && !!imageId && read.text.includes(`${imageId} at index`) && /\((59|60)x20pt\)/.test(read.text), res.text + '\n' + read.text.slice(-300))
res = await edit('replace_image', { documentId, imageId, uri: LOGO_SMALL })
read = await call('read_doc', { documentId })
check('replace_image keeps one image in place', !res.error && (read.text.match(/ at index \d+ \(/g) ?? []).length === 1, res.text + '\n' + read.text.slice(-300))

// Breaks and columns
res = await edit('insert_break', { documentId, type: 'column' })
check('red: unknown break type is refused', res.error && /type must be/.test(res.text), res.text)
res = await edit('insert_break', { documentId, type: 'page' })
let data = await raw()
check('insert_break adds a page break', !res.error && data.body.content.some(el => el.paragraph?.elements?.some(pe => pe.pageBreak)), res.text)
const sectionsBefore = data.body.content.filter(el => el.sectionBreak).length
res = await edit('insert_break', { documentId, type: 'section_continuous' })
data = await raw()
check('insert_break adds a section break', !res.error && data.body.content.filter(el => el.sectionBreak).length === sectionsBefore + 1, res.text)
res = await edit('set_section_columns', { documentId, find: 'intro line', columns: 5 })
check('red: five columns is refused', res.error && /1, 2 or 3/.test(res.text), res.text)
res = await edit('set_section_columns', { documentId, find: 'intro line', columns: 2, gap: 18 })
data = await raw()
let sections = data.body.content.filter(el => el.sectionBreak).map(el => el.sectionBreak.sectionStyle)
check('set_section_columns: first section has 2 columns, the last is untouched', !res.error && sections[0].columnProperties?.length === 2 && (sections.at(-1).columnProperties?.length ?? 0) < 2, res.text + JSON.stringify(sections.map(style => style.columnProperties)))

// Header, footer, footnote
res = await edit('set_header_footer', { documentId, kind: 'header', remove: true })
check('removing an absent header reports there is none', !res.error && /no header/.test(res.text), res.text)
res = await edit('set_header_footer', { documentId, kind: 'header', text: 'Head A' })
read = await call('read_doc', { documentId })
check('header is created with text', !res.error && /header: "Head A\\n"/.test(read.text), res.text + '\n' + read.text.slice(-300))
res = await edit('set_header_footer', { documentId, kind: 'header', text: 'Head B' })
res2 = await edit('set_header_footer', { documentId, kind: 'footer', text: 'Foot' })
read = await call('read_doc', { documentId })
check('header is replaced and footer created', !res.error && !res2.error && /header: "Head B\\n"/.test(read.text) && /footer: "Foot\\n"/.test(read.text), res.text + res2.text + '\n' + read.text.slice(-300))
res = await edit('set_header_footer', { documentId, kind: 'header', remove: true })
read = await call('read_doc', { documentId })
check('header is removed, footer stays', !res.error && !/header: /.test(read.text) && /footer: "Foot\\n"/.test(read.text), res.text + '\n' + read.text.slice(-300))
res = await edit('insert_footnote', { documentId, find: 'middle', text: 'note one' })
read = await call('read_doc', { documentId })
check('footnote is added with its text', !res.error && /footnote \S+: "[^"]*note one/.test(read.text), res.text + '\n' + read.text.slice(-300))

// Named ranges
res = await edit('replace_named_range', { documentId, name: 'nope', text: 'x' })
check('red: unknown named range is refused', res.error && /No named range "nope"/.test(res.text), res.text)
res = await edit('create_named_range', { documentId, name: 'slot', find: 'closing' })
read = await call('read_doc', { documentId })
check('named range is listed', !res.error && /"slot" \[\d+-\d+\]/.test(read.text), res.text + '\n' + read.text.slice(-300))
res = await edit('replace_named_range', { documentId, name: 'slot', text: 'final' })
read = await call('read_doc', { documentId })
check('named range content is replaced', !res.error && read.text.includes('final line') && !read.text.includes('closing'), res.text)
res = await edit('delete_named_range', { documentId, name: 'slot' })
read = await call('read_doc', { documentId })
check('named range is deleted, text stays', !res.error && !/"slot"/.test(read.text) && read.text.includes('final line'), res.text)

// Tabs
res = await call('read_doc', { documentId, tabId: 't.bogus' })
check('red: unknown tab is refused', res.error && /No tab t\.bogus/.test(res.text), res.text)
res = await call('read_doc', { documentId: `https://docs.google.com/document/d/${documentId}/edit?tab=t.0` })
check('tab is read from a Docs URL', !res.error && /\ntab: t\.0 /.test(res.text), res.text.slice(0, 200))
res = await edit('format_text', { documentId, tabId: 't.0', find: 'intro', italic: true })
read = await call('read_doc', { documentId, tabId: 't.0' })
check('explicit first-tab id works on an edit', !res.error && /"intro" \{italic\}/.test(read.text), res.text)
let secondTab
try {
  const added = await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ addDocumentTab: { tabProperties: { title: 'Second' } } }] } })
  secondTab = added.data.replies[0].addDocumentTab.tabProperties.tabId
} catch (e) {
  console.log(`SKIP  second-tab checks: the API would not create a tab (${e?.response?.data?.error?.message ?? e.message})`)
}
if (secondTab) {
  res = await edit('append_text', { documentId, tabId: secondTab, text: 'tab two text' })
  const two = await call('read_doc', { documentId, tabId: secondTab })
  const one = await call('read_doc', { documentId })
  check('append_text lands on the second tab only', !res.error && two.text.includes('tab two text') && !one.text.includes('tab two text') && one.text.includes(`${secondTab} "Second"`), res.text + '\n' + two.text.slice(0, 300))
  await edit('append_text', { documentId, text: ' tab two text' })
  res = await edit('replace_all_text', { documentId, tabId: secondTab, find: 'tab two text', replace: 'swapped' })
  const twoAfter = await call('read_doc', { documentId, tabId: secondTab })
  const oneAfter = await call('read_doc', { documentId })
  check('replace_all_text with a tabId leaves the other tab alone', !res.error && /Replaced 1 /.test(res.text) && twoAfter.text.includes('swapped') && oneAfter.text.includes('tab two text'), res.text)
  res = await edit('format_text', { documentId, tabId: secondTab, find: 'swapped', bold: true })
  const twoStyled = await call('read_doc', { documentId, tabId: secondTab })
  check('format_text works on the second tab', !res.error && /"swapped\\n" \{bold\}/.test(twoStyled.text), res.text + '\n' + twoStyled.text.slice(-200))
  res = await edit('set_page_setup', { documentId, tabId: secondTab, marginLeft: 20 })
  const twoPage = await call('read_doc', { documentId, tabId: secondTab })
  const onePage = await call('read_doc', { documentId })
  check('page setup applies per tab', !res.error && /left 20 /.test(twoPage.text) && /left 36 /.test(onePage.text), res.text + '\n' + twoPage.text.slice(0, 250))
}

res = await edit('edit_table', { documentId, table: 1, action: 'delete_table' })
check('red: deleting a table that holds protected text is refused', res.error && /deleting the table would remove/.test(res.text), res.text)
res = await edit('edit_table', { documentId, table: 1, action: 'delete_table', allowProtected: true })
read = await call('read_doc', { documentId })
check('delete_table removes it', !res.error && !read.text.includes('--- TABLES ---'), res.text)

await finish(documentId)
