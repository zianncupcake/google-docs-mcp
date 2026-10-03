import { connect } from './helpers.mjs'

const { client, call, edit, check, docs, scratch, finish } = await connect()
const line = (text, needle) => text.split('\n').filter(row => row.includes(needle) && row.startsWith('[')).join(' | ')

const names = (await client.listTools()).tools.map(tool => tool.name)
check('tools listed', names.includes('format_text') && names.includes('format_paragraph'), names.join(','))

const documentId = await scratch('<p>alpha beta gamma</p><p>second beta line</p>')
console.log('scratch doc', documentId)

let read = await call('read_doc', { documentId })
const firstRevision = /revisionId: (\S+)/.exec(read.text)[1]
check('baseline: nothing bold yet', !read.text.includes('{bold'), read.text)

let res = await edit('format_text', { documentId, find: 'nomatch', bold: true })
check('red: unknown text is refused', res.error && /not found/.test(res.text), res.text)
res = await edit('format_text', { documentId, find: 'beta', bold: true })
check('red: ambiguous match is refused', res.error && /matches 2 places/.test(res.text), res.text)
res = await edit('format_text', { documentId, find: 'alpha' })
check('red: no style is refused', res.error && /No style given/.test(res.text), res.text)
res = await edit('format_text', { documentId, find: 'alpha', bold: true, startIndex: 1, endIndex: 3 })
check('red: find plus range is refused', res.error && /not both/.test(res.text), res.text)
res = await edit('format_text', { documentId, find: 'alpha', foregroundColor: 'red' })
check('red: bad colour is refused', res.error && /6-digit hex/.test(res.text), res.text)
res = await edit('format_paragraph', { documentId, find: 'second' })
check('red: paragraph with no style is refused', res.error && /No style given/.test(res.text), res.text)
read = await call('read_doc', { documentId })
check('red calls changed nothing', !read.text.includes('{') || !/\{(bold|italic|underline)/.test(read.text), read.text)

await edit('insert_text', { documentId, index: 1, text: 'X' })
res = await edit('format_text', { documentId, find: 'alpha', bold: true, revisionId: firstRevision })
check('red: stale revisionId is refused', res.error && /changed since/.test(res.text), res.text)
read = await call('read_doc', { documentId })
check('stale call changed nothing', !/\{bold/.test(read.text), read.text)

res = await edit('format_text', { documentId, find: 'alpha', bold: true, italic: true })
read = await call('read_doc', { documentId })
check('bold+italic lands on alpha only', !res.error && /"alpha" \{bold,italic\}/.test(read.text) && !/beta[^\n]*\{bold/.test(read.text), res.text + '\n' + line(read.text, 'alpha'))

res = await edit('format_text', { documentId, find: 'BETA', matchCase: false, occurrence: 'all', underline: true, fontSize: 14, foregroundColor: '#ff0000' })
read = await call('read_doc', { documentId })
check('occurrence all styles both betas', !res.error && (read.text.match(/"beta" \{underline,14pt\}/g) ?? []).length === 2, res.text + '\n' + read.text)

res = await edit('format_text', { documentId, find: 'beta', occurrence: 2, strikethrough: true })
read = await call('read_doc', { documentId })
check('occurrence 2 styles only the second beta', !res.error && (read.text.match(/strikethrough/g) ?? []).length === 1 && /second [^\n]*\n[^\n]*strikethrough|"beta" \{underline,strikethrough,14pt\}/.test(read.text), res.text + '\n' + read.text)

const gamma = /\[(\d+)-(\d+)\] " gamma\\n"/.exec(read.text)
res = await edit('format_text', { documentId, startIndex: Number(gamma[1]) + 1, endIndex: Number(gamma[2]) - 1, bold: true, link: 'https://example.com/' })
read = await call('read_doc', { documentId })
check('range address bolds and links gamma', !res.error && /"gamma" \{bold,underline,link:https:\/\/example\.com\/\}/.test(read.text) && !/"alpha" [^\n]*link/.test(read.text), res.text + '\n' + line(read.text, 'gamma'))
res = await edit('format_text', { documentId, find: 'gamma', bold: false, link: '' })
read = await call('read_doc', { documentId })
check('false and "" clear bold and link', !res.error && !/gamma[^\n]*\{(bold|link)/.test(read.text), res.text + '\n' + line(read.text, 'gamma'))

res = await edit('format_paragraph', { documentId, find: 'second', alignment: 'CENTER', spaceAbove: 12, bullets: 'disc' })
const paragraphs = (await docs.documents.get({ documentId })).data.body.content.filter(el => el.paragraph).map(el => el.paragraph)
const textOf = paragraph => paragraph.elements.map(el => el.textRun?.content ?? '').join('')
const second = paragraphs.find(paragraph => textOf(paragraph).includes('second'))
const first = paragraphs.find(paragraph => textOf(paragraph).includes('alpha'))
check('paragraph: second is centred, spaced and bulleted', !res.error && second.paragraphStyle.alignment === 'CENTER' && second.paragraphStyle.spaceAbove?.magnitude === 12 && !!second.bullet, res.text + JSON.stringify(second.paragraphStyle))
check('paragraph: first is untouched', first.paragraphStyle.alignment !== 'CENTER' && !first.bullet, JSON.stringify(first.paragraphStyle))
res = await edit('format_paragraph', { documentId, find: 'second', bullets: 'none', namedStyleType: 'HEADING_2' })
const after = (await docs.documents.get({ documentId })).data.body.content.filter(el => el.paragraph).map(el => el.paragraph).find(paragraph => textOf(paragraph).includes('second'))
check('paragraph: bullets removed, heading applied', !res.error && !after.bullet && after.paragraphStyle.namedStyleType === 'HEADING_2', res.text + JSON.stringify(after.paragraphStyle))


// The safety checks the new tools inherit: required revision, protected text, drift.
res = await call('format_text', { documentId, find: 'gamma', bold: true })
check('red: missing revisionId is refused', res.error && /needs a revisionId/.test(res.text), res.text)
res = await edit('format_text', { documentId, find: 'alpha', underline: true })
read = await call('read_doc', { documentId })
check('red: styling protected (italic) text is refused', res.error && /protected \(italic\)/.test(res.text) && !/"alpha" \{[^}]*underline/.test(read.text), res.text)
res = await edit('format_paragraph', { documentId, find: 'gamma', namedStyleType: 'HEADING_1' })
check('red: a heading style on a paragraph holding protected text is refused', res.error && /strip the marker/.test(res.text), res.text)
res = await edit('format_paragraph', { documentId, find: 'gamma', alignment: 'END' })
check('aligning that paragraph is still allowed', !res.error, res.text)
res = await edit('format_text', { documentId, find: 'alpha', underline: true, allowProtected: true })
read = await call('read_doc', { documentId })
check('allowProtected lets the style through', !res.error && /"alpha" \{[^}]*underline/.test(read.text), res.text)
await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nwritten by the user' } }] } })
res = await edit('format_text', { documentId, find: 'gamma', bold: true })
check('red: an edit made outside the server is refused as drift', res.error && /since my last write/.test(res.text) && /written by the user/.test(res.text), res.text)
await call('sync_baseline', { documentId })
res = await edit('format_text', { documentId, find: 'gamma', bold: true })
check('after sync_baseline the edit goes through', !res.error, res.text)

await finish(documentId)
