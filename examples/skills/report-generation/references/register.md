# Writing register

Read this before writing `report.md`, not after. Style applied as a post-write patch never survives contact with the next edit.

## Contents

- [The two tiers have different registers](#the-two-tiers-have-different-registers)
- [Banned in both tiers](#banned-in-both-tiers)
- [Markdown tier: prose rules](#markdown-tier-prose-rules)
- [HTML tier: label rules](#html-tier-label-rules)
- [Honesty](#honesty)
- [Visual register](#visual-register)
- [Self-review checklist](#self-review-checklist)

## The two tiers have different registers

This matters, because the usual prose advice and the presentation advice contradict each other, and applying the wrong one to the wrong tier is how reports go bad in both directions.

| | `report.md` | `report.html` |
|---|---|---|
| Form | flowing prose, full sentences, paragraphs | assertion headlines, figures, captions |
| Bullets | only for genuinely enumerable things | the normal form |
| Headers | never over a two-sentence section | one per finding, always |
| Length | unlimited; exhaustive is the virtue | fixed budget; density is the virtue |
| Reader | someone who needs to disagree with you | someone deciding in two minutes |

So: **do not write the Markdown as a deck, and do not write the HTML as an essay.**

## Banned in both tiers

Words and constructions that mark generated text. The gate greps for these in rendered output.

- `leverage`, `harness` (as a verb), `utilize`, `delve`, `robust`, `seamless`, `cutting-edge`, `game-changer`, `unlock`, `supercharge`, `landscape` (figurative), `realm`, `testament to`, `it's worth noting that`, `it's important to note`
- Emoji in headings. Emoji anywhere in a report, in fact.
- Bold sprinkled mid-sentence for emphasis. Bold marks a term or a label, nothing else.
- Summary-recap endings: "In conclusion", "Overall", "In summary". The report ends with actions, not with a restatement.
- Fake-profound kickers — "the one to read twice", "and that changes everything". Delete the whole sentence; there is nothing to salvage.
- Rhetorical-question section openers.
- The "it's not X, it's Y" construction.
- Em dashes as a tic. At most one per 500 words of prose; the gate counts them.

## Markdown tier: prose rules

- **Format follows content.** A bullet list where two sentences would read better is formatting slop. A header over a two-sentence section is formatting slop.
- Lead with the finding, then the evidence. Never build up to a conclusion.
- Name the mechanism, not just the symptom. "Slow" is a symptom; "each request re-reads the whole index" is a mechanism.
- Give every number a unit and a denominator. "32 wasted calls" is not a fact; "32 of 100 retrieval calls" is.
- Quote sources verbatim when the exact wording matters. Paraphrase silently changes claims.
- Write the caveat where the claim is, not only in `## Caveats`.

## HTML tier: label rules

You do not write the HTML. You write the slots that project into it, so these are rules about slots.

- **Headline is an assertion with a verb**, 8–14 words. If it could be a slide title in a bad deck ("Results", "Performance Analysis"), it is wrong.
- **Caption states the takeaway, not the chart type.** "Two of four gaps sit below the noise floor" — not "Bar chart of criterion gaps".
- Caption must not restate the headline in other words. If it does, you have one thought and are padding.
- No hedges in the headline or the verdict. `may`, `might`, `could potentially`, `in some cases`, `arguably` — all belong in caveats or in the Markdown detail. A hedge in a headline means you have not decided what you found.
- Numbers in labels carry their unit and sign: `+1.00 points`, not `1.0`.

## Honesty

The tier split is what makes brevity honest. **The HTML never contains a fact absent from the Markdown, and nothing is omitted from the reader — it is relocated one click away.** You are not hiding the caveats; you are putting them where someone who wants to argue can find them.

Two failure modes to avoid in opposite directions:

- **Short and empty.** All slogans, zero facts, no comparative basis for a decision. A report that "says something and nothing" fails even though it is admirably brief.
- **Short and dishonest.** A confident headline whose caveat exists nowhere. Brevity by deletion rather than by relocation.

The bar is not "is it short". The bar is: **this is a decision instrument, not a pretty explainer — someone must walk away knowing what to do.** Paired with the stand-alone test: a reader of only the HTML must be able to act without opening the Markdown.

Render uncertainty as a threshold line, not a hedge clause.

## Visual register

Applied by the template; listed here because the figures you choose have to cooperate with it.

- **Fixed type scale in `rem`.** No fluid `clamp()` typography.
- **Display font on `h1`–`h3` only.** Everything smaller uses the text family. Labels never use the display face.
- **Tokens only, never a literal colour.** The palette lives in the four `:root` blocks of `assets/report.css`: two identity colours, a slate scale, five semantic tokens and six categorical ones. Adding a colour that is not in that set means the encoding is no longer consistent across figures.
- **Check the contrast of any accent you introduce, in both themes.** Warm mid-tones are the trap: a yellow that reads fine as a rule or a border fails badly as a background behind white text — the same pair can be 1.5:1 one way round and above 14:1 the other. If you re-skin, run the pairs, do not eyeball them.
- No gradients. No `backdrop-filter`. No left accent stripe on every card. No grid of identical boxes.
- Both themes via tokens under `prefers-color-scheme`, plus an explicit toggle. Every colour is defined in the light block first; the dark block redefines tokens only.
- `prefers-reduced-motion` disables all motion, and the base state is fully visible — the data must read if the script never runs.

## Self-review checklist

Walk this yourself against the rendered HTML before you report done. It is your check, not something to hand the user.

- [ ] Reading only the HTML, could I make the decision without opening the Markdown?
- [ ] Does every finding have a figure that carries the claim, rather than decorating it?
- [ ] Is there any sentence in the HTML that also exists in the Markdown, just reworded? Delete it; link instead.
- [ ] Does any section carry two independent claims? Split it.
- [ ] Any hedge words in a headline or the verdict? Move them to caveats.
- [ ] Does every number in the HTML appear in the Markdown?
- [ ] Does every chart state its scale maximum?
- [ ] Is the colour encoding identical across all figures?
- [ ] Did the gates pass, and did I read the warnings rather than only the errors?
- [ ] Did I open the file in a browser, in both themes and at mobile width? An agent reporting "done" is not the result. The artefact on disk is the result.
