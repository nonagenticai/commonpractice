# Copy style guide

CommonPractice is Kaizen for knowledge work. Readers are business people, not developers.
Write like a well-run internal tool: short, factual and calm. Often the best copy is none.

Scope: every member-facing string in `frontend/messages/*.json`, i.e. the prefixes
`home_ nav_ challenges_ challenge_ submit_ solutions_ solution_ winner_ build_ nodecfg_ console_ chat_ docs_`
`datasets_ dataset_ connectors_ ontology_ blocks_ flow_ blocksim_ blockauthor_ cycle_ cadence_ requests_ error_`.
Run errors that render on member pages (`blockerr_ blockresult_errkind_`) follow rules 1, 2 and 6 too.
`frontend/src/lib/i18n/copy-style.test.ts` enforces the mechanical rules below and fails CI:
rules 1, 2 and 6 in all eight locales; the word caps (rule 4) in en and nl; and rules 3, 8 and 9
over the WHOLE catalog, admin screens included (rule 3 where a locale has separate second-person
words: en nl de fr es pl; rule 9 in nl).

## Rules

1. **Titles are nouns, not questions.** "Challenges", not "What should be better tomorrow?".
   No `?` in any `_title`, `_heading` or `_hero` key.
2. **No coaching and no greetings.** No "Hi", "Hoi", "Hello", no "Got a different angle?", no
   pep talk ("None of this is wasted"). State what is there and what it does.
3. **No "you/your" in headings.** Headings name the thing ("Work area", "My activity" at most).
   Body text may address the reader when it is the plainest wording.
4. **Helper text is about 12 words at most**, or it is deleted when the control explains itself.
   The test caps titles at 8 words and body strings at 20; long-form docs paragraphs at 40.
5. **Sentence case.** "Submit a challenge", not "Submit A Challenge". Product names keep their case.
6. **No technical jargon** in member-facing strings: JSON, sandbox, upstream, mock data,
   LLM, console, payload, schema, PII, cardinality, materialize. Use: *test environment*,
   *previous step*, *sample data*, *AI*, *run log*, *columns*, *personal data*, *copied in*.
7. **One term per concept.** Sample data (not test data / mock data / sample material),
   test environment (not sandbox), solution round (not Solution leaderboard phase).
8. **Errors say what failed, then what to do.** "Datasets could not be loaded. Try again."
   No "We couldn't…", no "Please", no apologies — in every locale ("Helaas", "Bitte", "Veuillez",
   "يرجى", "אנא" …). `error_load_failed`: "Could not load. Try again." / "Laden mislukt. Probeer het opnieuw."
9. **Dutch is written as native business Dutch**, not translated English: "Uitdaging indienen",
   not "Dien de jouwe in"; "Testomgeving", not "sandbox". Use *je* consistently in body text, never *u*; no anglicisms
   where a normal Dutch word exists. The other locales follow the same meaning and register.
10. **Placeholders stay intact** (`{name}`, `{count}`); keys are never renamed by a copy change.

## Before / after

| Key | Before | After |
|---|---|---|
| `home_hero_title` | What's worth voting on this week? | Kaizen for knowledge work |
| `submit_title` | What should be better, in your work? | Submit a challenge |
| `challenges_title` | What should be better tomorrow? | Challenges |
| `solutions_cta_title` | Got a different angle on this challenge? | Alternative solution |
| `chat_intro` | Hi — tell me what you want to build and I'll assemble it on the canvas. … | Describe what to build, e.g. "add a step that summarises the claim". |
| `build_sandbox_pill` | Sandbox: isolated · mock data | Test environment · sample data |
| `submit_field_tags_hint` | Helps colleagues find your challenge. Up to {max} tags. | Up to {max} tags. |
| `challenge_data_load_failed` | We couldn't load your datasets. Please try again. | Datasets could not be loaded. Try again. |
| nl `submit_title` | Wat zou beter moeten zijn in jouw werk? | Uitdaging indienen |
| nl `chat_intro` | Hoi — vertel me wat je wilt bouwen en ik zet het op het canvas. … | Beschrijf wat je wilt bouwen, bijv. "voeg een stap toe die de claim samenvat". |

## Removed

- `docs_quote`: an invented testimonial attributed to a person who does not exist. Never
  attribute copy to a real-sounding person unless that person said it and agreed to its use.
