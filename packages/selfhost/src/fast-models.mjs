const suffix = '~morons-fast';
const supported = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

export const fastModelId = (id) => `${id}${suffix}`;
export const isFastModelId = (id) => typeof id === 'string' && id.endsWith(suffix);
export const baseModelId = (id) => isFastModelId(id) ? id.slice(0, -suffix.length) : id;
export const supportsFastModel = (model) => model?.provider === 'openai' &&
  model.api === 'openai-responses' && supported.has(model.id);

export function installFastModels(models) {
  const provider = models.getProvider('openai');
  if (!provider) return;
  const resolve = (model, context, options, stream) => {
    if (!isFastModelId(model.id)) return stream(model, context, options);
    const original = provider.getModels().find((candidate) => candidate.id === baseModelId(model.id));
    if (!supportsFastModel(original)) throw new Error('fast_model_unavailable');
    return stream(original, context, { ...options, serviceTier: 'priority' });
  };
  models.setProvider({ ...provider,
    getModels: () => {
      const catalog = provider.getModels();
      return [...catalog, ...catalog.filter(supportsFastModel)
        .map((model) => ({ ...model, id: fastModelId(model.id) }))];
    },
    stream: (model, context, options) => resolve(model, context, options,
      (selected, messages, request) => provider.stream(selected, messages, request)),
    streamSimple: (model, context, options) => resolve(model, context, options,
      (selected, messages, request) => provider.streamSimple(selected, messages, request)),
  });
}
