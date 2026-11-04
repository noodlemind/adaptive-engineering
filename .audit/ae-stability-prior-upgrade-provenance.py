import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description='Compare the qualified release archives with their exact Git source commits.')
parser.add_argument('repository', type=Path)
parser.add_argument('old_archive', type=Path)
parser.add_argument('candidate_archive', type=Path)
parser.add_argument('output_json', type=Path)
args = parser.parse_args()
cases = [
    ('old', args.old_archive, '0.14.1', 'e1d1cdff2743d16b1d2522374e18267df5e205af', '253273e04c7464c6eb1cfee0f9ad5d43e2197f8e6c04e82c0f531a976d573a5b'),
    ('candidate', args.candidate_archive, '0.14.2', 'eb319b4c1d442644926a0db3caee7f3fa295bab5', '751a94fd08cf4d1597bca40751010984a2ac0e0a8723b95e4fbf7913db2f69f3'),
]
receipts = {'schema': 1, 'verdict': 'VERIFIED', 'archives': {}}
for role, archive, version, commit, expected_digest in cases:
    actual_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert actual_digest == expected_digest, (role, 'archive differs from the qualified artifact')
    source_tar = subprocess.check_output(['git', 'archive', f'{commit}:packages/ae'], cwd=args.repository)
    with tarfile.open(fileobj=io.BytesIO(source_tar), mode='r:') as sources:
        source_files = {entry.name: sources.extractfile(entry).read() for entry in sources.getmembers() if entry.isfile()}
    compared = {}
    bundled_files = 0
    with tarfile.open(archive, 'r:gz') as packed:
        for entry in packed.getmembers():
            if not entry.isfile():
                continue
            assert entry.name.startswith('package/'), entry.name
            relative = entry.name[len('package/'):]
            if relative.startswith('node_modules/'):
                bundled_files += 1
                continue
            assert relative in source_files, (role, 'packaged file absent from commit', relative)
            packed_bytes = packed.extractfile(entry).read()
            assert packed_bytes == source_files[relative], (role, 'archive differs from commit', relative)
            compared[relative] = hashlib.sha256(packed_bytes).hexdigest()
    assert json.loads(source_files['package.json'])['version'] == version
    receipts['archives'][role] = {
        'commit': commit, 'version': version, 'archive': str(archive.resolve()), 'sha256': actual_digest,
        'shippedSourceFilesCompared': len(compared), 'bundledDependencyFiles': bundled_files,
        'allShippedSourceBytesMatchCommit': True,
        'sourceFilesSha256': hashlib.sha256(json.dumps(compared, sort_keys=True).encode()).hexdigest(),
    }
args.output_json.parent.mkdir(parents=True, exist_ok=True)
args.output_json.write_text(json.dumps(receipts, indent=2) + '\n')
print(json.dumps(receipts, indent=2))
