"""Check a candidate release preserves the active floating-scroll UI (READ ONLY).

    python ops/remote.py ops/51_ui_release_guard.py <candidate-sha12>

Reads release metadata and the six UI files only. Never changes pointers, services,
database contents, credentials or schedules. A newer implementation may change
the file contents; the global shell/CSS integration must remain present.
"""
import json
import pathlib
import re
import sys


BASE = pathlib.Path('/opt/biomie-v2')
UI_FILES = (
    'docs/FLOATING_TABLE_SCROLL.md',
    'src/components/layout/GlobalFloatingTableScroll.tsx',
    'src/lib/floating-table-scroll.ts',
    'src/routes/_authenticated/_shell.tsx',
    'src/styles.css',
    'src/styles/floating-table-scroll.css',
)


def release(short):
    if not re.fullmatch(r'[a-f0-9]{12}', short):
        raise ValueError('Release must be a 12-character lowercase commit prefix')
    directory = BASE / 'releases' / short
    if not directory.is_dir() or directory.resolve() != directory:
        raise ValueError('Release directory is missing or is a symlink')
    metadata_path = directory / 'RELEASE.json'
    if metadata_path.resolve() != metadata_path:
        raise ValueError('Release metadata must not be a symlink')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    commit = metadata.get('commit', '')
    if (metadata.get('short') != short or not re.fullmatch(r'[a-f0-9]{40}', commit)
            or not commit.startswith(short)):
        raise ValueError('Release metadata does not match its directory')
    return directory, commit


def ui_state(directory):
    contents = {}
    missing = []
    for relative in UI_FILES:
        path = directory / relative
        if path.resolve() != path:
            raise ValueError('UI source path must not contain symlinks: ' + relative)
        if not path.is_file():
            missing.append(relative)
            continue
        contents[relative] = path.read_text(encoding='utf-8')
        if not contents[relative].strip():
            missing.append(relative)
    shell = contents.get('src/routes/_authenticated/_shell.tsx', '')
    styles = contents.get('src/styles.css', '')
    wiring = {
        'shell_import': bool(re.search(
            r'\bfrom\s*[\'\"]@/components/layout/GlobalFloatingTableScroll[\'\"]', shell)),
        'shell_mount': bool(re.search(r'<GlobalFloatingTableScroll(?:\s|/|>)', shell)),
        'css_import': bool(re.search(
            r'@import\s*[\'\"](?:\./)?styles/floating-table-scroll[.]css[\'\"]', styles)),
    }
    return {
        'has_controller': 'src/lib/floating-table-scroll.ts' in contents,
        'complete': not missing and all(wiring.values()),
        'missing_files': missing,
        'missing_wiring': [name for name, present in wiring.items() if not present],
    }


def main():
    if len(sys.argv) != 2:
        raise ValueError('Expected one candidate release prefix')
    candidate = sys.argv[1]
    candidate_directory, candidate_commit = release(candidate)
    pointers = {}
    for line in (BASE / 'shared/stack.env').read_text(encoding='utf-8').splitlines():
        key, separator, value = line.partition('=')
        if separator and key.strip() in ('RELEASE_ID', 'SOURCE_DIR', 'BIOMIE_GIT_COMMIT'):
            if key.strip() in pointers:
                raise ValueError('Active release pointer occurs more than once')
            pointers[key.strip()] = value.strip().strip('\"').strip("'")
    active = pointers.get('RELEASE_ID', '')
    active_directory, active_commit = release(active)
    if pointers.get('SOURCE_DIR') != str(active_directory) or pointers.get('BIOMIE_GIT_COMMIT') != active_commit:
        raise ValueError('Active release pointers disagree with release metadata')
    active_ui, candidate_ui = ui_state(active_directory), ui_state(candidate_directory)
    preserves = not active_ui['has_controller'] or candidate_ui['complete']
    print(json.dumps({
        'active': active, 'active_commit': active_commit,
        'candidate': candidate, 'candidate_commit': candidate_commit,
        'active_has_ui': active_ui['has_controller'],
        'candidate_has_ui': candidate_ui['complete'],
        'preserves_ui': preserves,
        'missing_files': candidate_ui['missing_files'],
        'missing_wiring': candidate_ui['missing_wiring'],
        'reason': None if preserves else 'Regenerate this candidate with the global floating-scroll UI before activation',
    }, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print stack.env contents or a traceback containing file contents.
        print(json.dumps({'preserves_ui': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
