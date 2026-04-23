# Music Debugger POC

A very small local proof of concept for the "music debugger" idea.

## What it does
- Upload a WAV mix
- Runs a rough heuristic analysis
- Returns:
  - ranked **Fix First** issues
  - ranked **Strengths**
- Click any item to inspect why it was flagged and what to try next

## What it does **not** do yet
- No real conversational chat under each issue yet
- WAV only for now
- No stems
- No genre/intent selector
- The analysis is deliberately broad-brush and heuristic-based

## Run locally

```bash
cd music_debugger_poc
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload
```

Then open:

```text
http://127.0.0.1:8000
```

## Notes
This is built to prove the workflow, not to be sonically authoritative.
The next upgrade would be:
1. MP3/AIFF support
2. per-issue chat
3. genre/intent toggle
4. section-aware analysis
5. better feature extraction and reference-track comparison
