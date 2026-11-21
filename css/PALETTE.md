# Palette

Every colour in `atlas.css` was chosen by running candidates through a palette
validator rather than by eye, and re-run until it passed. This file records what
was checked and what the final values scored, so the choices are auditable
instead of a matter of taste.

Surface under test: `--paper` `#f4f0e6`. The site is light-only by design — a
paper ground is the concept, and an inverted "dark paper" mode would read as a
different document rather than the same one at night.

## Categorical series

| Slot | Hue | Hex |
|---|---|---|
| 1 | indigo | `#2a5f9b` |
| 2 | terracotta | `#c0562c` |
| 3 | verdigris | `#008571` |
| 4 | ochre | `#a87a0c` |
| 5 | clay rose | `#bf6482` |
| 6 | moss | `#5d7f26` |
| 7 | aubergine | `#574596` |
| 8 | brick | `#ad3a30` |

All eight pass on the **adjacent** pairlist — the right test for stacked areas,
grouped bars and multi-line charts, where only neighbouring slots touch:

- Lightness band: all 8 inside OKLCH L 0.43–0.77
- Chroma floor: all 8 at C ≥ 0.10
- CVD separation: worst adjacent pair verdigris↔terracotta, ΔE **9.2** protan (target ≥ 8)
- Normal-vision floor: worst adjacent pair clay rose↔ochre, ΔE **15.9** (floor ≥ 15)
- Contrast vs paper: all 8 at ≥ 3:1

Two earlier candidates failed and were fixed rather than shipped: an indigo at
`#35618f` and a verdigris at `#16796b` both fell below the chroma floor
(C 0.089 and 0.088) — muted far enough to start reading as grey and stop doing
identity work — and an ochre at `#b38310` sat at 2.99:1, just under the contrast
gate.

### The three-series cap

On the **all-pairs** list — scatter, bubble, choropleth, small multiples, where
any two marks can end up side by side — only the first three slots pass:

- worst pair verdigris↔terracotta, CVD ΔE **9.9**, normal-vision ΔE **15.1**

Adding the fourth slot fails hard: ochre↔terracotta scores CVD ΔE **3.1**
(deuteranopia) and normal-vision ΔE **10.1**, meaning readers with full colour
vision can't reliably tell them apart either. So those chart forms carry at most
three colour-coded series and fold the remainder into "other" or facet instead.
This is why the small-multiples grid of all 36 offence types draws every panel
in slot 1: the panel headings carry identity, not the colour.

## Sequential ramp (indigo)

`--seq-1` … `--seq-7`: `#dce5f0` `#bbcde4` `#8daacf` `#6e90bd` `#4c72a4`
`#33578a` `#1e3c63`

Monotone light→dark, every adjacent gap ΔL ≥ 0.06, hue spread 4°. An earlier
version had `#3d6196` and `#2a5f9b` adjacent at ΔL 0.01 — two steps that looked
identical — and was respaced.

The two lightest steps are for **continuous** fills only, where the palest tint
legitimately means "near zero" and may recede into the paper. Binned choropleth
legends are an **ordinal** ramp and start at `--seq-3` `#8daacf`, the lightest
step that clears the 2:1 floor against paper (2.10:1).

## Diverging ramp (indigo ↔ brick)

Cool arm `#1e3c63` `#4c72a4` `#8daacf`, neutral midpoint `#e6e1d4`, warm arm
`#d99584` `#b85444` `#9c2f26`. Equal steps per arm; both arms validate as
single-hue ordinal ramps. The warm light end began at `#e3a596` (1.83:1) and was
darkened to `#d99584` (2.05:1) to clear the floor. The midpoint is a warm neutral
rather than a hue, so "no change" reads as nothing.

## Ink

Measured as WCAG contrast ratios against `--paper` `#f4f0e6`:

| Token | Hex | On paper | Use |
|---|---|---|---|
| `--ink` | `#231f1a` | 14.39:1 | body, headings |
| `--ink-soft` | `#565044` | 7.03:1 | secondary prose, axis titles |
| `--ink-muted` | `#6f6757` | 4.92:1 | captions, axis labels |
| `--rule` | `#ddd6c6` | 1.27:1 | hairlines only, never text |

`--ink-muted` was originally `#837a6b`, which measured 3.72:1 — legal for large
text and UI but not for the caption and axis-label sizes it is actually used at.
It was darkened until it cleared 4.5:1.

Text always wears an ink token, never a series colour; where a chart label needs
to carry identity, a coloured mark sits beside it.
