// Every paragraph element of a body in reading order, including those inside table cells.
export function* paragraphElements(content) {
  for (const el of content ?? []) {
    yield* el.paragraph?.elements ?? []
    for (const row of el.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) yield* paragraphElements(cell.content)
    }
  }
}
