import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
REPO = 'chayapats/schway'
PLAN = json.loads((ROOT / 'publication-manifest.json').read_text())
STATE_FILE = ROOT / 'published.json'


def gh(*args):
    result = subprocess.run(['gh', *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'gh {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()


def save(state):
    temp = STATE_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(state, indent=2) + '\n')
    temp.replace(STATE_FILE)


existing = json.loads(gh('issue', 'list', '--repo', REPO, '--state', 'all',
                         '--limit', '1000', '--json', 'number,title,body,url'))
state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
for ticket in PLAN:
    key = str(ticket['id'])
    marker = f'<!-- schway-roadmap:v03:{ticket["id"]:02d} -->'
    matches = [i for i in existing if marker in i['body']]
    if len(matches) > 1:
        raise RuntimeError(f'Duplicate publication marker: {key}')
    if matches:
        found = matches[0]
        state[key] = {'number': found['number'], 'url': found['url'],
                      'title': found['title']}

body_dir = ROOT / 'published-bodies'
body_dir.mkdir(exist_ok=True)
for ticket in PLAN:
    key = str(ticket['id'])
    body = ticket['body'].split('## Blocked by\n')[0] + '## Blocked by\n\n'
    if ticket['blocks']:
        body += '\n'.join(f'- #{state[str(b)]["number"]}: {next(t["title"] for t in PLAN if t["id"] == b)}'
                          for b in ticket['blocks']) + '\n'
    else:
        body += 'None (can start immediately).\n'
    body_file = body_dir / f'{ticket["id"]:02d}.md'
    body_file.write_text(body)
    title = f'[{ticket["stage"]}] {ticket["title"]}'
    if key not in state:
        url = gh('issue', 'create', '--repo', REPO, '--title', title,
                 '--label', 'ready-for-agent', '--body-file', str(body_file))
        number = int(url.rstrip('/').split('/')[-1])
        state[key] = {'number': number, 'url': url, 'title': title}
        save(state)
        print(f'Created {key}: #{number} {ticket["title"]}', flush=True)
    number = state[key]['number']
    if 'database_id' not in state[key]:
        state[key]['database_id'] = int(gh('api', f'repos/{REPO}/issues/{number}', '--jq', '.id'))
        save(state)
    if ticket['blocks']:
        actual = json.loads(gh('api', f'repos/{REPO}/issues/{number}/dependencies/blocked_by'))
        current = {entry['number'] for entry in actual}
        for blocker in ticket['blocks']:
            entry = state[str(blocker)]
            if 'database_id' not in entry:
                entry['database_id'] = int(gh('api', f'repos/{REPO}/issues/{entry["number"]}', '--jq', '.id'))
                save(state)
            if entry['number'] not in current:
                gh('api', '--method', 'POST', f'repos/{REPO}/issues/{number}/dependencies/blocked_by',
                   '-F', f'issue_id={entry["database_id"]}')
                print(f'Linked #{number} blocked by #{entry["number"]}', flush=True)

# The research task needs an exact destination for its self-contained handoff.
handoff = ('\n## Handoff destination\n\n'
           f'The production implementation is #{state["18"]["number"]}. '
           'Before making that task ready to implement, replace its "Verified integration contract" '
           'section with the complete verified contract or the exact unresolved condition. '
           'The implementing agent must not need to read this research discussion.\n')
research_file = body_dir / '17.md'
research_file.write_text(research_file.read_text() + handoff)
gh('issue', 'edit', str(state['17']['number']), '--repo', REPO,
   '--body-file', str(research_file))
save(state)
print(f'Published {len(state)} issues with native blockers.', flush=True)
