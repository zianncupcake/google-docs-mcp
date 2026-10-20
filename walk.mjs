// Every paragraph element of a body in reading order, including those inside table cells.
export function* paragraphElements(content) {
  for (const el of content ?? []) {
    yield* el.paragraph?.elements ?? []
    for (const row of el.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) yield* paragraphElements(cell.content)
    }
  }
}

// The text style of the run holding a character index, or undefined if no run does.
// Used to carry styling across a replacement: the Docs API styles inserted text from its
// surroundings, so without this a replacement silently takes the neighbouring run's
// formatting instead of the formatting of the text it replaced.
export function textStyleAt(content, index) {
  for (const pe of paragraphElements(content)) {
    if (pe.textRun && pe.startIndex <= index && index < pe.endIndex) return pe.textRun.textStyle ?? {}
  }
  return undefined
}
