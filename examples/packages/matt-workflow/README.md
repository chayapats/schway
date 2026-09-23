# Matt-style workflow example

Five user-invoked skills carry a coding task through decisions, specification,
local tickets, implementation, and review. All instructions are Markdown;
the package declares no executable extension, lifecycle script, runtime dependency,
or workflow state. Tested with Schway 0.1.0's configured package support.

From a Schway source checkout, pack the example without publishing it:

```sh
npm pack ./examples/packages/matt-workflow --ignore-scripts
```

In the target project, install that tarball with your package manager:

```sh
npm install --offline --ignore-scripts /absolute/path/schway-example-matt-workflow-1.0.0.tgz
```

Add `"schway-example-matt-workflow"` to the `packages` array in the project's
`.schway/config.json`, preserving other settings. For a new configuration:

```json
{ "packages": ["schway-example-matt-workflow"] }
```

Run `schway -p "/skills"` to inspect discovery without a provider. With a configured
provider, run `schway` and submit one invocation per stage, substituting real paths:

```text
/grill-with-docs Improve greetings; read README.md; write workflow/decisions.md
/grill-with-docs workflow/decisions.md Trim names; blank names greet "world"; keep punctuation.
/to-spec workflow/decisions.md workflow/spec.md
/to-tickets workflow/spec.md workflow/tickets/
/implement workflow/tickets/T1.md workflow/spec.md
/code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md
```

Answers and source artifacts travel in the invocation arguments and files. Repeat
the current skill on subsequent turns, including when answering questions or
resuming after cancellation. Ordinary chat does not reactivate the role. Generated
artifacts propose the next invocation; the user chooses whether to submit it.

Project `.agents/skills/<name>/SKILL.md` overrides this package. Two enabled
project packages declaring the same skill name make that name ambiguous unless
a project directory overrides them. Inspect `/skills` to verify the selected source,
especially in repositories already defining `implement` or `code-review`.

Remove the package name from `packages` and start a fresh turn/session to disable
it; optionally uninstall it with your package manager. Ordinary tools and your
artifact files remain usable. No migration or workflow cleanup is required.

Offline evidence and the optional real-task procedure are in the source repository's
`docs/matt-workflow.md`; run `bun test tests/matt-workflow.test.ts` there. Scripted
verification demonstrates wiring and file effects, not a live model's judgment.
