# The graphics standard

Every chart, card and table that goes into an article answers to this page. Each article contract
in `weekly-job-prompt.md` points here. The odds graphic is the `tiers` block (tier cards): see
**The default odds graphic** at the end.

## The look

- **ESPN / broadcast.** A dark ground, a red accent, and bold condensed type: the look of the
  article teaser and its card. It should read like a lower-third on a Sunday broadcast, not a
  spreadsheet.
- **Tiers, not lists.** Group teams into tiers ("Locked in", "On the bubble", "Long shots"), never
  a raw list of twelve. The tier name says what the numbers mean.
- **Polished, not blocky.** Rounded cards, hairline rules, one accent colour. No heavy boxes, no
  rainbow fills, no borders on everything.
- **Phone first.** Most of the league reads on a phone. A bracket is a real bracket on a phone, not
  a list that stands in for one. Names wrap onto a second line; they are never cut off with an
  ellipsis or hidden behind a scroll.
- **Minimal clutter.** One number per row that matters, and nothing a reader has to decode. If a
  label, legend or gridline does not change what somebody takes away, cut it.
- **Hero number first.** The number is the headline: first and big. The team and its managers sit
  under it, smaller.

## The process

1. **Check at 390px first.** Open the piece at 390px wide before anything else. Nothing overflows,
   nothing is clipped, every name is whole.
2. **Make the main number stand out.** It should be the first thing the eye lands on in each row.
3. **Cut clutter.** Remove anything that is not doing work: the intro under the headline is at most
   one short line, and anything longer becomes a footnote under the block.
4. **Compare against this page.** Go down the list above and fix what does not match.

## New graphic types

A graphic type the site has not printed before needs **two or three options**, shown side by side,
before one is picked. If Drew does not answer, pick the one that best fits this standard and keep
going: never hold a piece for a reply.

## The default odds graphic: `tiers`

Any article that charts playoff or title odds uses a `tiers` block unless there is a reason the
piece cannot (say so in the commit). It renders tier cards: a tier name, then a row per team with
the hero percentage first, the team and managers under it, a bar, and an optional bye chance.

```json
{"type": "tiers", "title": "Who gets in", "intro": "Playoff odds after week 6.",
 "foot": "10,000 simulated seasons. Six teams make it; the top two get a bye.",
 "tiers": [
   {"name": "Locked in", "rows": [
     {"team": "<Sleeper display_name>", "managers": "Team name", "pct": 97.4, "last": 91.0, "bye": 62, "seed": 1, "status": "in"}
   ]},
   {"name": "On the bubble", "rows": [ … ]}
 ]}
```

- `title` (required): the headline over the cards.
- `intro`: **one short line** at most (80 characters). Detail goes in `foot`.
- `foot`: the footnote under the block: method, sample size, caveats.
- `tiers[]`: each `{name, rows[]}`; rows top to bottom within a tier.
- Row fields: `team` (a manager's Sleeper `display_name`, required), `pct` (playoff chance, 0-100,
  required), `managers` (the line under the number), `last` (last week's playoff chance, 0-100),
  `bye` (0-100), `seed` (integer), `status` (`"in"`, `"out"` or `"bye"`).
- Optional block fields: `kicker` (the red line over the title), `cutAfter` (the `team` of the row
  the playoff line sits under), `href` (https or `#`) with `link` (its words). A tier may carry a
  `range` ("85% or better") and a row a `rec` ("4-1"). `sub` and `note` are accepted for `intro`
  and `foot`, the names the first version used.
- When `team` is a manager the site knows, the card shows the fantasy team name with the
  display_name under it.
- **Decimals.** The site prints a whole number unless two rows would round to the same figure while
  their values differ; then those rows get one decimal. Write the real value, not a rounded one.
- **Change arrows.** An up or down arrow (and the points moved) shows only when the row carries
  `last`. With no `last`, the row shows no arrow and no placeholder.
- **Long shots.** A bar never disappears: a 0.3% team still gets a visible stub.

`node check-recaps.mjs` validates the block. Open `?tierdemo` on the site to see a sample.
