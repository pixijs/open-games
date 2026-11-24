# Venue checks

How a custom track gets its scenery, and the checks that hold it to Night Run's look. Night Run itself keeps its
curated venue (`src/track/base.ts`); everything here is about the rules in `src/track/plan.ts`.

## The rules

`planVenue(def, route, treeSeed)` works a custom track's venue out from its route, so every player's is the same but
for the trees:

- **Ground.** The grass is centred on the road's box and reaches 100 m past it (200 m across at least); the physics
  slab reaches 30 m past it.
- **Floodlight towers.** First by rule, as Night Run's stand: past the finish line, outside every corner group
  (U-turns first) and beside every straight of four cells or more. Then a greedy fill: while a road sample (every 5 m)
  is more than 14 m from every tower's aim point, or less than 62% of the road (a metre at a time) gets the light of a
  quarter of Night Run's median, the spot that reaches or lights the most road goes up. A spot is a mast on the grass,
  10 m tall, 7.5 m or 11 m off the road, or, where packed lanes leave no grass near enough, a lane-divider mast on the
  shared barrier between two parallel straights, aimed 12 m down the barrier so its cone falls on both lanes. Masts
  stand 5.5 m clear of every road and 12 m from each other; dividers 8 m from any tower. At most 24. If the rule
  towers leave the road short (packed tracks such as `max`), the venue is planned again with the fill alone and the
  better of the two is kept.
- **The light model** (`lampLight`) is pixi-3d's spot falloff worked on the CPU: the 30-degree cone with its 0.6
  penumbra, the 28 m range window and the inverse square. It gives Night Run's own towers 68% of the road at the
  bar, which is where the 62% goal and the checks' 55% floor come from.
- **The light pool.** The set always holds six spot lights and three point lights. With six towers or fewer, light
  `i` stands on tower `i` and never moves (Night Run). With more, `src/look/set/LampPool.ts` ranks the towers every
  0.25 s by how near their aim points are to the road 15 m ahead of the camera's truck (at the truck itself on a
  crane cam, and on every staging shot but the attract race's). The nearest tower is always lit; any other takes a
  light only once it's 5 m nearer than the farthest lit one. A light holds its tower at least a second: it fades out
  over 0.5 s, moves, and fades in over 0.5 s.
- **The light tunnel.** Five portals 3 m apart over the longest straight of two cells or more, away from the finish
  cell and its neighbours, with no road beside it and every post at least 3.9 m from any other road; ties go to the
  run farthest from the line. None when no run has room.
- **TV cranes.** Greedy cover from spots inside and outside every corner group and beside every straight of three
  cells or more, 6 m clear of the road and 3 m from any tower's foot: every road sample within 32 m of a crane, at
  least 4 and at most 12. Road those spots can't reach gets spots beside any sample, and where packed lanes leave no
  grass that near (the middle of `max`), a camera 12 m above the barrier between two lanes.
- **Trees.** On every free cell within three cells of the road, from `treeSeed`: tents or a three-tree clump right
  beside it, thicker forest further out, each a random quarter turn. None on a mast's foot, a crane's cell or beside
  the tunnel, no forest next to a crane, at most 360 pieces.

## The checks

```sh
npx tsx scripts/venue/check-plans.ts [count]        # the check tracks and `count` (500) random tracks
```

`check-plans.ts` re-measures every plan with its own arithmetic: tower clearances, spacing and divider placement,
the 5 m coverage and the 55% lit floor, the light pool over two laps from a cold start, tunnel posts, crane count
and coverage, trees off reserved cells, and that a seed only moves trees.
