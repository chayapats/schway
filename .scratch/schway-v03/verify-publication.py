import concurrent.futures
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
REPO = 'chayapats/schway'
PLAN = json.loads((ROOT / 'publication-manifest.json').read_text())
STATE = json.loads((ROOT / 'published.json').read_text())


def api(path):
    result = subprocess.run(['gh', 'api', path], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def verify(ticket):
    entry = STATE[str(ticket['id'])]
    actual = api(f'repos/{REPO}/issues/{entry["number"]}')
    expected = (ROOT / 'published-bodies' / f'{ticket["id"]:02d}.md').read_text()
    assert actual['body'].replace('\r\n', '\n').strip() == expected.strip(), f'Body mismatch: {entry["number"]}'
    assert actual['title'] == entry['title'], f'Title mismatch: {entry["number"]}'
    assert actual['state'] == 'open'
    assert 'ready-for-agent' in [label['name'] for label in actual['labels']]
    assert 'Draft ' not in actual['body']
    blockers = api(f'repos/{REPO}/issues/{entry["number"]}/dependencies/blocked_by')
    expected_ids = {STATE[str(b)]['number'] for b in ticket['blocks']}
    assert {b['number'] for b in blockers} == expected_ids, f'Blocker mismatch: {entry["number"]}'
    return {'draft': ticket['id'], 'number': entry['number'], 'url': entry['url'],
            'words': len(actual['body'].split()), 'blockers': sorted(expected_ids),
            'verified': True}


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(verify, PLAN))
(ROOT / 'verification.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'verified_issues': len(results),
                  'verified_native_edges': sum(len(r['blockers']) for r in results),
                  'all_bodies_match': True,
                  'all_labels_correct': True}, indent=2))
