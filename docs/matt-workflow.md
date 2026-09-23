# External Matt-style workflow

The [example package](../examples/packages/matt-workflow/README.md) supplies
`grill-with-docs`, `to-spec`, `to-tickets`, `implement`, and `code-review`.
Its manifest declares only skill directories. All five roles use standard
`disable-model-invocation: true` metadata: the user initiates each stage,
including follow-up answers. The package adds no tools, JavaScript entrypoint,
dependencies, or persistent workflow state. It stays private and is validated as
a local tarball; registry publication is unnecessary.

Use the package README's pack/install/configuration commands from any target
repository. Inspect `schway -p "/skills"` before starting; local project skills
override packaged roles. In this Schway repository, existing `implement` and
`code-review` definitions therefore win. Use an isolated target repository to
exercise all five packaged roles without modifying those definitions.

The current task and artifact paths are ordinary invocation arguments. Each
skill reads its input files, writes its output artifact, and proposes the next
explicit user invocation. Schway only handles generic skill activation and
ordinary tool calls. A following turn, resumed session, error, or cancellation
does not retain the active body. Reinvoke the appropriate role with the current
artifacts. Partial files remain available for inspection; their existence is not
evidence that verification completed.

## Reproduce the offline demonstration

From a source checkout with Bun and npm available:

```sh
bun install --frozen-lockfile
bun test tests/matt-workflow.test.ts
bun run typecheck
```

The six tests use isolated temporary homes and project directories. The main
demonstration initializes its own Git repository and packs the actual example
with `npm pack --offline --ignore-scripts`. It installs the local tarball with
`npm install --offline --ignore-scripts`, enables it in `.schway/config.json`,
then drives real headless CLI turns with a scripted model. No provider,
credentials, GitHub tracker, email service, or network write is needed. The
model scripts request only local read/write/edit operations and the fixture's
`bun test greet.test.ts` command.

The initial fixture returns `"Hello, " + name + "!"`. The user resolves two
questions: trim surrounding whitespace, and treat a blank name as `world`.
Punctuation and ordinary greetings must remain unchanged. The observable
criteria are:

| Criterion | Input | Required output |
| --- | --- | --- |
| A1 | `"  Ada  "` | `"Hello, Ada!"` |
| A2 | `""` and `"   "` | `"Hello, world!"` |
| A3 | `"Lin"` | `"Hello, Lin!"` |

The test checks real tool results and file contents at each handoff:

| Artifact in the temporary repository | Observed handoff |
| --- | --- |
| `workflow/decisions.md` | First contains unanswered questions; a second explicit grill turn records the user's answers and D1–D3. |
| `workflow/spec.md` | Consumes decisions and records A1–A3, examples, scope, and verification command. |
| `workflow/tickets/T1.md`, `workflow/tickets/index.md` | Local tracker includes independent implementation context, edit scope, criteria, prerequisites, and pending status. |
| `greet.ts`, `greet.test.ts` | Implementation reads the ticket and spec, creates tests, observes two failures, edits the source, and reruns the tests. |
| `workflow/tickets/T1-implementation.md` | Records affected files and actual before/after command outcomes; proposes a review invocation. |
| `workflow/review.md` | Reads spec, ticket, source, tests, and implementation record; reruns the command and records criterion dispositions and limits. |

Temporary files and local tarballs are removed by test teardown. Exact
deterministic artifacts and invocations are in
[the test source](../tests/matt-workflow.test.ts); rerun it to regenerate them.
Scripted responses establish the harness handoffs and effects. They do not
evaluate a live model's ability to ask useful questions, design a specification,
implement an unfamiliar task, or judge its own work.

## Recorded evidence

Observed on 2026-09-22 with Bun 1.4.2; the full repository suite was
revalidated on 2026-09-23 after rebasing onto the merged #44 changes:

| Check | Outcome |
| --- | --- |
| Packed contents | Passed: package manifest, README, and five SKILL.md files only; no executable capability or install script. |
| Ordinary package discovery and explicit turns | Passed: all five roles load from the installed package and receive artifact/task arguments in user messages. |
| Model eligibility | Passed: all five attempted `activate_skill` calls return user-only errors; workflow bodies are absent from model discovery metadata. |
| Artifact sequence | Passed: resolved decisions, spec, ticket, implementation record, and review are written and consumed through real tools. |
| Before implementation | Expected failing baseline: `bun test greet.test.ts` exits 1 with 1 pass and 2 fail. |
| After implementation and review | Passed: the same command exits 0 with 3 pass and 0 fail, independently rerun during review. |
| Overrides and duplicate declarations | Passed: project directories win; duplicate project package roles are ambiguous until resolved. |
| Interrupted turns | Passed: provider failure and cancellation preserve written artifacts; ordinary resume has no active body, and explicit reinvocation works. |
| Disabled package | Passed: removing its configured name removes skill discovery/invocation, while an ordinary resumed turn still runs the fixture tests. Artifacts remain intact. |
| Focused package suite | Passed: 6 tests, 0 failures. |
| Full repository suite | Passed on 2026-09-23: `bun test`, 625 tests, 0 failures, 3884 assertions across 49 files. |
| Type checking | Passed: `bun run typecheck`. |
| Live-provider execution | Pending: not run; deterministic validation uses a scripted model. |
| Human dogfood on a real task | Pending: requires a separately chosen real task and human answers. |

## Optional human dogfood

Use a disposable checkout or worktree of a real coding project and a small real
task you want completed. Configure your chosen Schway provider separately. This
exercise may use paid model calls; it is an opt-in procedure, not part of
`bun test`.

1. Pack/install/enable the local package using its README. Run `/skills` and
   record each role's source. Resolve any project override deliberately before
   relying on the packaged role.
2. Start `schway`. Invoke
   `/grill-with-docs <real task and source documents>; write workflow/decisions.md`.
   Answer questions through fresh `/grill-with-docs workflow/decisions.md <answers>`
   turns. Review the recorded decisions before proceeding.
3. Submit `/to-spec workflow/decisions.md workflow/spec.md`, inspect acceptance
   criteria, then submit `/to-tickets workflow/spec.md workflow/tickets/`.
   Keep this tracker local; external issue creation is a separate user action.
4. Select an actual ticket and invoke
   `/implement workflow/tickets/T1.md workflow/spec.md`. Record changed files and
   exact check commands, exit codes, and relevant output in
   `workflow/tickets/T1-implementation.md`. Retain failing or unavailable checks
   as failed or pending. Following interruption, inspect files before resuming.
5. Invoke
   `/code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md`.
   Inspect the source and independently run the review's verification commands.
   Compare results with each spec criterion; preserve the report at
   `workflow/review.md`.
6. Remove only this package's name from the `packages` array, start a fresh
   turn/session, inspect `/skills`, and ask ordinary Schway to read or test the
   changed code. Record whether the base coding workflow still works. Artifacts
   remain ordinary project files; uninstalling the package is optional.

Write `workflow/dogfood-evidence.md` with the task/repository revision, Schway and
package versions, selected provider/model (without credentials), actual
invocations, artifact paths, changed files, and a row per criterion containing
`passed`, `failed`, or `pending`, the observed command/output, and any reason.
Record live-provider quality and the human's assessment separately from offline
wiring checks. If credentials, answers, or a task are unavailable, record the
specific pending step and stop that procedure; do not relabel scripted evidence
as human dogfood.
