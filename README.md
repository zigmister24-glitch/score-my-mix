# Mix Analyzer V4

A clean V4 front-end scaffold for the WAV upload + section analysis workflow.

## Included in this revision

- Drag-and-drop upload anywhere on screen
- WAV playback with play/pause button
- Waveform display using `wavesurfer.js`
- Auto-detected change points for song sections
- Colour-coded section heat map using time ranges only
- Clickable Top moment and Next lift cards
- Previous / Next section navigation inside the selected panel
- Clickable score cards with plain-English explanations
- Tonal balance score card and genre-aware note
- Strengths surfaced alongside recommendations

## Install

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite.

## Editable tonal genres

Scarlett Lullaby and four User Defined slots can be renamed and edited with
**Edit genre** beside the track's genre selector. Target offsets range from
-12 to +12 dB relative to Modern Pop. Targets are normalised together; these
settings change analysis references, not the audio. Tonal readouts show signed
dB relative to the selected target; the existing percentage-based scoring is retained.
Profile IDs stay fixed so renaming does not change saved song selections.
Profiles are shared across browsers/users of this deployment, as are the existing
saved settings. Local Vite development saves these profiles in localStorage.

Before deploying this feature, open the existing Cloudflare D1 database's SQL
console and run `db/genre-profiles.sql`. This creates the new `genre_profiles`
table without altering existing tables. Defaults appear for empty slots; saving
creates or updates the corresponding row. Deploy both the frontend and the new
`functions/api/genre-profiles.js` endpoint. If the API or migration is missing, analysis continues with currently loaded
profiles (built-in defaults when none have loaded) and displays a warning.
Saving requires a successful JSON response from the API.

Include the API and migration files when committing this feature:

```bash
git add src dist functions/api/genre-profiles.js db/genre-profiles.sql tests/custom-genres.mjs README.md
```

Validation:

```bash
node tests/custom-genres.mjs
npm run build
```

### Presence band upgrade

Tonal Balance and Density now include Presence (2–5 kHz), sampled at 3.2 kHz.
The editor includes a Presence dB offset; it adjusts both tonal and density
references. Existing saved profiles without this value start at 0 dB.
These remain overlapping filter estimates, not brick-wall spectral bands.

For an existing database, run `db/genre-profiles-presence.sql` once before
publishing. New databases can use the updated `db/genre-profiles.sql` instead;
do not run the ALTER migration after creating the new five-band schema.
Deploy `functions/api/genre-profiles.js` together with the frontend.

Tonal score weights: Weight 20%, Body 25%, Core 25%, Presence 20%, Air 10%.
Density uses a weighted average of excess outside band tolerances: Weight 20%,
Body 30%, Core 20%, Presence 20%, Air 10%. The deduction is 1.25 times this
average. A severe-band safeguard starts above 12 points outside tolerance:
1.25 times the excess beyond 12. The larger deduction applies, without stacking. Five-band references are renormalised, so scores
can differ from earlier four-band results and should be reviewed by ear.

### Vocal preference adjustment

Editable profiles include a Vocal target adjustment from -6 to +6 dB.
Positive values raise the expected vocal-to-mix ratio; negative values lower it.
Zero preserves the genre's existing target. This is a preference for the vocal
estimate, not a vocal stem gain or a change to the audio. Built-in profiles show
this adjustment read-only at zero. Existing profiles default to zero.

Before deploying to an existing D1 database, run `db/genre-profiles-vocals.sql`
once. Deploy `functions/api/genre-profiles.js` with the frontend. New databases
can use the latest `db/genre-profiles.sql` directly instead of ALTER migrations.


### Band audition

Hold the headphone button beside a Tonal Balance reading to audition that
labelled frequency range in the selected section. Release, leave the button,
or switch focus/section to restore normal playback. Keyboard users can hold
Space or Enter on the button. If playback was paused, audition starts at the
section beginning and stops on release. Existing playback continues when the
button is released. Audition stops at the selected section end.

Browser Web Audio high-pass/low-pass filters use the labelled band boundaries
with gradual slopes, a 20 ms dry/wet crossfade and no automatic gain boost.
This is a listening aid, not a soloed instrument or the exact analyser filter.
No files, scoring targets or database records are changed.

Run `node tests/band-audition.mjs` to check the audio routing and filter setup.
