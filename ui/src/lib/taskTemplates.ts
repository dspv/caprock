/**
 * Task templates — the starting points on the Tasks screen (.ai/04-ui.md § Tasks).
 *
 * A blank form asked a first-time user three questions at once: what is a good
 * task, how do I word it, and which commands prove it. A template answers the
 * first two and leaves the third to the repository: each one names the *kinds*
 * of check it wants (tests, lint, the project's own umbrella check), and
 * `checksFor` fills them from what `GET /v1/hive/starter` found in the repo's
 * files. Nothing here is a command, so nothing here can be wrong for a repo it
 * has never seen — a template in a repository with no detected checks prefills
 * none, and the form says so.
 *
 * The parts the user has to fill in are written `<like this>` and listed in
 * `placeholders`; the form will not create a task while one is still there.
 * Templates carry no budget: the form's budget is the user's, and empty means
 * the daemon's own ceiling (`default_budget_usd`), never a figure invented here.
 */
import type { CheckKind, DetectedCheck } from './api'

export interface TaskTemplate {
  id: string
  /** The card's name. */
  name: string
  /** One line under it: when you would pick this. */
  blurb: string
  /** The task title it prefills. */
  title: string
  /** The instructions it prefills — what the worker reads. */
  prompt: string
  /** Which checks it wants, in order of preference. The first kind the repo
   *  has wins; `all` is the project's own umbrella check (`make check`). */
  wants: CheckKind[][]
  /** The `<…>` parts the user still has to replace. */
  placeholders: string[]
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'fix-tests',
    name: 'Fix failing tests',
    blurb: 'The suite is red. Find out why and make it green.',
    title: 'Fix the failing tests in <folder>',
    prompt:
      'Some tests in <folder> fail. Find the cause and fix the code, not the test.\n' +
      'If a test itself is wrong, fix it and say why in the commit message.\n' +
      'Do not skip, delete or loosen a test to make it pass.',
    wants: [['test'], ['all']],
    placeholders: ['<folder>'],
  },
  {
    id: 'bump-dep',
    name: 'Bump a dependency',
    blurb: 'Upgrade one package and keep everything passing.',
    title: 'Upgrade <package> to <version>',
    prompt:
      'Upgrade <package> to <version>.\n' +
      'Read its changelog for breaking changes and update every call site they touch.\n' +
      'Change nothing else. Commit the lockfile with it.',
    wants: [['all'], ['test', 'lint', 'typecheck', 'build']],
    placeholders: ['<package>', '<version>'],
  },
  {
    id: 'add-tests',
    name: 'Add tests for a file',
    blurb: 'Cover code that has no tests yet.',
    title: 'Add tests for <file>',
    prompt:
      'Write tests for <file>: what it promises its callers, the edge cases, and the error paths.\n' +
      'Follow the test style already used in this repository.\n' +
      'Do not change the code under test unless a test finds a real bug; if it does, fix it and say so.',
    wants: [['test'], ['all']],
    placeholders: ['<file>'],
  },
  {
    id: 'fix-lint',
    name: 'Fix lint and type errors',
    blurb: 'Make the linter and the type checker quiet.',
    title: 'Fix the lint and type errors',
    prompt:
      'Make the linter and the type checker pass.\n' +
      'Fix the code; do not disable rules, add ignore comments or loosen the config.\n' +
      'If a rule is genuinely wrong for one line, leave that line and explain it in the commit message.',
    wants: [['lint', 'typecheck'], ['all'], ['build']],
    placeholders: [],
  },
  {
    id: 'write-docs',
    name: 'Write docs for a module',
    blurb: 'Explain what a module is for and how to use it.',
    title: 'Document <module>',
    prompt:
      'Document <module>: what it is for, how to use it, and one short example per public entry point.\n' +
      'Put it where this repository keeps docs for code (doc comments, or a README in that folder).\n' +
      'Do not change behaviour.',
    wants: [['all'], ['build', 'lint'], ['test']],
    placeholders: ['<module>'],
  },
  {
    id: 'port-script',
    name: 'Port a script',
    blurb: 'Rewrite a script in another language, same behaviour.',
    title: 'Port <script> to <language>',
    prompt:
      'Rewrite <script> in <language> with the same behaviour, flags and output.\n' +
      'Add a test that runs it on a representative input and checks the output.\n' +
      'Keep the old script until the new one passes, then remove it and update anything that called it.',
    wants: [['test'], ['all']],
    placeholders: ['<script>', '<language>'],
  },
]

/**
 * checksFor picks a template's checks from what the repository declares. For
 * the first preference group the repo can satisfy at all, it takes one command
 * per kind — the first found, which is the project's own entry point before the
 * toolchain's stock command (`make test` before `go test ./...`), so the same
 * suite is not run twice. With no template it is the general default: the
 * umbrella check, else tests, lint, type checks.
 */
export function checksFor(t: TaskTemplate | undefined, checks: DetectedCheck[]): string[] {
  const groups: CheckKind[][] = t ? t.wants : [['all'], ['test', 'lint', 'typecheck']]
  for (const kinds of groups) {
    const picked: string[] = []
    for (const kind of kinds) {
      const c = checks.find((x) => x.kind === kind)
      if (c && !picked.includes(c.command)) picked.push(c.command)
    }
    if (picked.length > 0) return picked
  }
  return []
}

/** The placeholders of a template still present in what the user typed. */
export function unfilled(t: TaskTemplate | undefined, ...texts: string[]): string[] {
  if (!t) return []
  const all = texts.join('\n')
  return t.placeholders.filter((p) => all.includes(p))
}
