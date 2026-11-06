/**
 * Syntax highlighting for the file tab (.ai/04-ui.md § File tabs), loaded
 * only when a code file is opened: `import('@/lib/highlight')` keeps
 * highlight.js out of the app's own chunks. The core and a dozen languages,
 * no auto-detection. The output is not HTML for the page: highlight.js's
 * escaped markup is read back into lines of plain-text segments, each with
 * a colour role, which React draws as text.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { HlRole, HlSeg } from './files'

const LANGS = { bash, css, dockerfile, go, ini, javascript, json, makefile, markdown, python, sql, typescript, xml, yaml }
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def)

/** highlight.js's scope → the colour role the tab draws it in. */
const ROLES: Record<string, HlRole> = {
  keyword: 'kw', 'selector-tag': 'kw', operator: 'kw',
  string: 'str', regexp: 'str', addition: 'str', 'template-tag': 'str', 'template-variable': 'str', code: 'str',
  number: 'num', literal: 'num', symbol: 'num',
  comment: 'com', quote: 'com', doctag: 'com',
  title: 'fn', section: 'fn', strong: 'fn',
  type: 'type', built_in: 'type', 'selector-class': 'type', 'selector-id': 'type',
  tag: 'tag', name: 'tag', deletion: 'tag',
  attr: 'attr', attribute: 'attr', property: 'attr', variable: 'attr', 'selector-attr': 'attr', 'selector-pseudo': 'attr', bullet: 'attr', link: 'attr', emphasis: 'attr',
  meta: 'meta', subst: 'meta',
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e)

/** The role of the innermost scope that has one. */
function roleOf(stack: readonly string[]): HlRole | '' {
  for (let i = stack.length - 1; i >= 0; i--) {
    const r = ROLES[stack[i]!]
    if (r) return r
  }
  return ''
}

/**
 * The text's lines as coloured segments, or null for a language not
 * registered here. A trailing newline makes no empty last line, as in the
 * tab's plain view.
 */
export function highlightLines(text: string, language: string): HlSeg[][] | null {
  if (!hljs.getLanguage(language)) return null
  let html: string
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
  const lines: HlSeg[][] = [[]]
  const stack: string[] = []
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] !== undefined) {
      stack.push(m[1].split(' ')[0]!.replace(/^hljs-/, ''))
    } else if (m[2] === undefined) {
      stack.pop()
    } else {
      const role = roleOf(stack)
      const parts = unescape(m[2]).split('\n')
      parts.forEach((t, i) => {
        if (i > 0) lines.push([])
        if (t) lines[lines.length - 1]!.push({ r: role, t })
      })
    }
  }
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop()
  return lines
}
