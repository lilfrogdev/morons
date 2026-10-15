import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createProviderAuth } from "./provider-auth.mjs";


export function createPiProviderAuth({ credentials, getDeviceId }) {
  if (!credentials) throw new Error("persistent_credential_store_required");
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  return { models, auth: createProviderAuth({ models, credentials, getDeviceId }) };
}
