#!/usr/bin/env python3
"""Check current Agent Notes structure and local documentation links (Python 3.10+)."""

import argparse
from datetime import date
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

LIFECYCLES = ("proposed", "implemented", "rejected")
CLASSES = ("architecture", "process", "feature", "bug-fix", "simplification", "testing")
REQUIRED = {
    "proposed": ("Proposal", "Acceptance criteria", "Risks"),
    "implemented": ("Decision", "Consequences"),
    "rejected": ("Proposal",),
}


def prose(text: str) -> str:
    """Exclude fenced examples and comments from grammar and link checks."""
    text = re.sub(r"<!--[\s\S]*?-->", "", text)
    lines, fence = [], None
    for line in text.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, rest = match.groups()
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not rest.strip():
                fence = None
            continue
        if fence is None:
            lines.append(line)
    return "\n".join(lines)


def heading_ids(text: str) -> set[str]:
    ids, counts = set(), {}
    for heading in re.findall(r"^#{1,6} +(.+?)(?: +#+)?$", prose(text), re.M):
        slug = re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        ids.add(slug if count == 0 else f"{slug}-{count}")
    return ids


def check(root: Path) -> list[str]:
    errors = []
    notes_root = root / ".agents/notes"
    for name in ("README.md", "AGENTS.md", "implemented/AGENTS.md"):
        if not (notes_root / name).is_file():
            errors.append(f"{notes_root / name}: required file is missing")
    identities = set()
    documents = {*notes_root.rglob("*.md"), *root.glob(".agents/skills/**/*.md"),
                 root / "AGENTS.md", root / "README.md"}
    for source in sorted(documents):
        if not source.is_file():
            continue
        text = source.read_bytes().decode("utf-8")
        if "\r" in text or not text.endswith("\n") or text.endswith("\n\n"):
            errors.append(f"{source}: use LF and exactly one trailing newline")
        body = prose(text)
        if source.is_relative_to(notes_root) and source.name not in ("README.md", "AGENTS.md"):
            parts = source.relative_to(notes_root).parts
            match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})-.+\.md", source.name)
            try:
                valid_date = match is not None and date.fromisoformat(match[1]).isoformat() == match[1]
            except ValueError:
                valid_date = False
            if len(parts) != 3 or parts[0] not in LIFECYCLES or parts[1] not in CLASSES or not valid_date:
                errors.append(f"{source}: expected lifecycle/class/YYYY-MM-DD-topic.md")
                continue
            if source.name in identities:
                errors.append(f"{source}: duplicate note identity")
            identities.add(source.name)
            lifecycle = parts[0]
            lines = text.splitlines()
            status = r"Status: rejected — \S.*" if lifecycle == "rejected" else f"Status: {lifecycle}"
            if len(lines) < 4 or not re.match(r"^# Agent Note: \S", lines[0]) or lines[1] != "" or not re.fullmatch(status, lines[2]) or lines[3] != "":
                errors.append(f"{source}: invalid title/status header")
            if len(re.findall(r"^Status:", body, re.M)) != 1:
                errors.append(f"{source}: expected exactly one Status line")
            headings = re.findall(r"^## (.+)$", body, re.M)
            if not headings or headings[0] != "Problem":
                errors.append(f"{source}: first section must be Problem")
            for name in (*REQUIRED[lifecycle], "Alternatives considered"):
                if name not in headings:
                    errors.append(f"{source}: missing {name}")
            if lifecycle == "implemented" and any(re.match(r"(Proposal|Plan|Migration plan|Acceptance criteria)\b", h, re.I) for h in headings):
                errors.append(f"{source}: implemented notes cannot contain proposal-era headings")
        for link in re.findall(r"\]\(([^\s)]+)\)", body):
            url = urlsplit(link)
            if url.scheme or url.netloc:
                continue
            target = (source.parent / unquote(url.path)).resolve() if url.path else source
            if not target.exists():
                errors.append(f"{source}: missing local link {link}")
            elif url.fragment and target.suffix == ".md" and unquote(url.fragment) not in heading_ids(target.read_text()):
                errors.append(f"{source}: missing heading link {link}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("command", choices=["check"])
    args = parser.parse_args()
    try:
        errors = check(args.root.resolve())
    except (OSError, ValueError) as error:
        errors = [str(error)]
    if errors:
        print("Agent Notes validation failed:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1
    print("Agent Notes check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
