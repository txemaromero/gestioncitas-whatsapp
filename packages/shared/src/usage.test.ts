import { describe, expect, it } from 'vitest';
import { addUsage, DEFAULT_USAGE_PRICES, emptyUsageTotals, estimateUsageCost, mergeUsageTotals, resolveUsagePrices } from './usage';

describe('usage totals and estimated cost (F31)', () => {
  const totals = () => {
    const t = emptyUsageTotals();
    for (const row of [
      { metric: 'whatsapp.inbound', model: '', amount: 10 },
      { metric: 'whatsapp.outbound', model: '', amount: 1_200 },
      { metric: 'whatsapp.template', model: '', amount: 50 },
      { metric: 'llm.requests', model: 'gpt-4o-mini', amount: 4 },
      { metric: 'llm.prompt_tokens', model: 'gpt-4o-mini', amount: 1_000_000 },
      { metric: 'llm.completion_tokens', model: 'gpt-4o-mini', amount: 500_000 },
      { metric: 'llm.prompt_tokens', model: 'deepseek-chat', amount: 1_000 },
      { metric: 'transcription.seconds', model: 'gpt-transcribe', amount: 120 },
      { metric: 'unknown.metric', model: '', amount: 99 },
    ]) {
      addUsage(t, row);
    }
    return t;
  };

  it('adds the counters up by metric and model', () => {
    const t = totals();
    expect(t).toEqual({
      inbound: 10,
      outbound: 1_200,
      templates: 50,
      llm: {
        'gpt-4o-mini': { requests: 4, promptTokens: 1_000_000, completionTokens: 500_000 },
        'deepseek-chat': { requests: 0, promptTokens: 1_000, completionTokens: 0 },
      },
      transcription: { 'gpt-transcribe': 120 },
    });
    expect(mergeUsageTotals(t, t)).toMatchObject({ inbound: 20, llm: { 'gpt-4o-mini': { requests: 8 } }, transcription: { 'gpt-transcribe': 240 } });
  });

  it('prices tokens, minutes of voice, templates and replies above the free allowance', () => {
    const cost = estimateUsageCost(totals(), DEFAULT_USAGE_PRICES);
    // 1M × 0.15 + 0.5M × 0.60 = 0.45; 2 min × 0.0045 = 0.009.
    expect(cost.ai).toBeCloseTo(0.459, 6);
    // 50 templates × 0.02 + (1200 − 1000) replies × 0.02.
    expect(cost.whatsapp).toBeCloseTo(5, 6);
    // Without a price: shown without cost.
    expect(cost.unpriced).toEqual(['deepseek-chat']);
    expect(estimateUsageCost(emptyUsageTotals(), DEFAULT_USAGE_PRICES)).toEqual({ ai: 0, whatsapp: 0, unpriced: [] });
  });

  it('takes prices from PLATFORM_PRICES over the defaults and ignores an invalid value', () => {
    const { prices, error } = resolveUsagePrices(
      JSON.stringify({ llm: { 'deepseek-chat': { input: 0.27, output: 1.1 } }, whatsapp: { template: 0.0166 } }),
    );
    expect(error).toBeNull();
    expect(prices.llm['deepseek-chat']).toEqual({ input: 0.27, output: 1.1 });
    expect(prices.llm['gpt-4o-mini']).toEqual(DEFAULT_USAGE_PRICES.llm['gpt-4o-mini']);
    expect(prices.whatsapp).toEqual({ ...DEFAULT_USAGE_PRICES.whatsapp, template: 0.0166 });
    expect(estimateUsageCost(totals(), prices).unpriced).toEqual([]);

    expect(resolveUsagePrices(undefined)).toEqual({ prices: DEFAULT_USAGE_PRICES, error: null });
    expect(resolveUsagePrices('{oops')).toMatchObject({ prices: DEFAULT_USAGE_PRICES, error: expect.stringMatching(/JSON/) });
    expect(resolveUsagePrices('{"whatsapp":{"template":-1}}').error).toMatch(/PLATFORM_PRICES no válido/);
    expect(resolveUsagePrices('{"currency":"EUR"}').error).toMatch(/PLATFORM_PRICES no válido/);
  });
});
