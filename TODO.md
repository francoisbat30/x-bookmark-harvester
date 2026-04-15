# TODO

## Deep Search — llmScore vs engagement rebalancing

After the bulk-validation fix (commit `5d95a9e`), Deep Search returns real candidates but the final ranking still lets off-topic high-engagement posts survive in the top-15 because `finalScore = mechanicalScore + llmScore × 5` doesn't weight LLM judgment hard enough.

**Observed on the Veo 3.1 run (2026-04-16)**: positions #10, #11, #14, #15 were off-topic (Seedance 2, Gemini workflow non-Veo, hybrid VFX, PixVerse V6) with `llmScore ∈ [1..2]`, yet they ranked above clearly relevant Veo threads with lower engagement.

### Planned changes

1. **Repondération du finalScore** (`lib/x/deep-search.ts::aggregationRerank`)
   - Current : `finalScore = mechanicalScore + llmScore * 5`
   - New     : `finalScore = mechanicalScore * 0.5 + llmScore * 15`
   - Effect : llmScore=1 → −15 versus baseline, llmScore=5 → +75. Off-topic posts with good engagement drop hard.

2. **UI toggle "Hide low relevance"** (`app/components/DeepSearch.tsx`)
   - Checkbox next to the "All / None / Extract N" bar
   - When on, filters out candidates with `llmScore < 3`
   - Default: off (so the user sees what the rebalance already accomplishes)

3. **Bump article bonus once more** (optional, gut call)
   - Article bonus 25 → 35
   - Justification : articles are rare but high-value, and on new topics (Veo 3.1) there are none — bumping has zero downside

### Tests to add
- `finalScore` formula unit test with fixed mechanical/llm values → verify ordering
- `llmScore < 3` filter test with a mixed fixture
- Article boost regression test

### Done criteria
- Re-run the exact Veo 3.1 query, top 10 should be 100 % Veo-relevant (no Seedance/PixVerse survivors)
- 86 → ~89 tests, all green
- Commit + push
