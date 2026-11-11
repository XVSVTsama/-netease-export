import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

OWNER = 'XVSVTsama'
REPO = '-netease-export'
TOKEN = re.search(r'https://[^:]+:([^@]+)@github\.com', open('/workspace/.git-keys/git-credentials').read()).group(1)
SKIP = {'node_modules', '.git', 'target', 'gen', 'dist', 'out2', '导出'}


def api(path, method='GET', body=None):
    req = urllib.request.Request(
        'https://api.github.com' + path,
        method=method,
        headers={
            'Authorization': 'token ' + TOKEN,
            'User-Agent': 'eta-agent',
            'Accept': 'application/vnd.github+json',
            **({'Content-Type': 'application/json'} if body is not None else {}),
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')


def walk(base):
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in sorted(files):
            if f.endswith('.log'):
                continue
            p = os.path.join(root, f)
            out.append((os.path.relpath(p, base).replace(os.sep, '/'), p))
    return out


def push(src_dir, message):
    files = walk(src_dir)
    print('文件数', len(files))
    st, ref = api(f'/repos/{OWNER}/{REPO}/git/ref/heads/main')
    if st != 200:
        print('读取 ref 失败', st, ref)
        sys.exit(1)
    base_commit = ref['object']['sha']
    st, c = api(f'/repos/{OWNER}/{REPO}/git/commits/{base_commit}')
    base_tree = c['tree']['sha']
    print('baseline', base_commit[:8])

    tree = []
    for rel, abs_path in files:
        content = open(abs_path, 'rb').read()
        st, blob = api(f'/repos/{OWNER}/{REPO}/git/blobs', 'POST', {
            'content': base64.b64encode(content).decode(),
            'encoding': 'base64',
        })
        if st != 201:
            print('  blob 失败', rel, st, str(blob)[:150])
            continue
        tree.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print('  +', rel)
    print('blob 完成', len(tree))

    st, t = api(f'/repos/{OWNER}/{REPO}/git/trees', 'POST', {'base_tree': base_tree, 'tree': tree})
    if st != 201:
        print('tree 失败', st, t)
        sys.exit(1)
    st, commit = api(f'/repos/{OWNER}/{REPO}/git/commits', 'POST', {
        'message': message, 'tree': t['sha'], 'parents': [base_commit],
    })
    if st != 201:
        print('commit 失败', st, commit)
        sys.exit(1)
    st, r2 = api(f'/repos/{OWNER}/{REPO}/git/refs/heads/main', 'PATCH', {'sha': commit['sha']})
    print('ref →', st, commit['sha'][:8])


if __name__ == '__main__':
    push(sys.argv[1], sys.argv[2])
