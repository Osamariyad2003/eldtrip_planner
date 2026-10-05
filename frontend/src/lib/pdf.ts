/**
 * PDF export (FR-EXP-01).
 *
 * Renders each day's SVG straight into a vector PDF page, so lines stay crisp
 * and the text stays selectable. jsPDF and svg2pdf are loaded on demand, which
 * keeps them out of the initial bundle (NFR-PERF-04).
 */

/** US Letter landscape, in points. */
const PAGE_W = 792
const PAGE_H = 612

export async function exportLogsToPdf(sheets: SVGSVGElement[], filename: string): Promise<void> {
  if (sheets.length === 0) throw new Error('No log sheets to export')

  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')])

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' })

  for (const [index, sheet] of sheets.entries()) {
    if (index > 0) doc.addPage('letter', 'landscape')
    // svg2pdf reads computed styles, so the clone is measured in the document
    // before being drawn and removed again.
    const clone = prepareForExport(sheet)
    document.body.append(clone)
    try {
      await svg2pdf(clone, doc, { x: 0, y: 0, width: PAGE_W, height: PAGE_H })
    } finally {
      clone.remove()
    }
  }

  doc.save(filename)
}

/**
 * Inline the stylesheet rules the sheet depends on.
 *
 * The live sheets are styled by an external stylesheet; svg2pdf only honours
 * presentation attributes and inline styles, so each element's resolved paint
 * and font properties are copied onto it.
 */
function prepareForExport(source: SVGSVGElement): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(PAGE_W))
  clone.setAttribute('height', String(PAGE_H))
  clone.style.position = 'fixed'
  clone.style.left = '-10000px'
  clone.style.top = '0'

  const originals = source.querySelectorAll<SVGElement>('*')
  const clones = clone.querySelectorAll<SVGElement>('*')
  const properties = [
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linecap',
    'stroke-linejoin',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'letter-spacing',
    'text-anchor',
    'opacity',
  ]

  originals.forEach((original, index) => {
    const target = clones[index]
    if (!target) return
    const computed = window.getComputedStyle(original)
    for (const property of properties) {
      const value = computed.getPropertyValue(property)
      if (value) target.style.setProperty(property, value)
    }
    target.removeAttribute('class')
  })
  clone.removeAttribute('class')
  return clone
}

export function pdfFilename(startDate: string, days: number): string {
  return `eld-logs-${startDate}-${days}day${days === 1 ? '' : 's'}.pdf`
}
