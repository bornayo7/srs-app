import { useEffect, useState } from 'react';
import { Badge, Button, Field, Panel, Select, Status, TextInput } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import {
  ANTHROPIC_MODELS,
  OPENAI_COMPAT_PRESETS,
  getAiConfig,
  saveAiSettings,
  setAnthropicKey,
  setOpenaiKey,
  type AiProvider,
} from '@/ai/config';
import { testConnection } from '@/ai/client';

export function AiSettings() {
  const operation = useOperation();
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [anthropicModel, setAnthropicModel] = useState<string>(ANTHROPIC_MODELS[0].id);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState('');
  const [key, setKey] = useState('');
  const [savedKeys, setSavedKeys] = useState({ anthropic: false, openai: false });
  useEffect(() => {
    let alive = true;
    void getAiConfig()
      .then((cfg) => {
        if (!alive) return;
        setProvider(cfg.provider);
        setAnthropicModel(cfg.anthropic.model);
        setOpenaiBaseUrl(cfg.openai.baseUrl);
        setOpenaiModel(cfg.openai.model);
        setSavedKeys({ anthropic: !!cfg.anthropic.apiKey, openai: !!cfg.openai.apiKey });
      })
      .catch((error) => {
        if (alive)
          operation.setError(
            error instanceof Error ? error.message : 'Provider settings could not load.',
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async () => {
    await saveAiSettings({
      provider,
      anthropicModel,
      openaiBaseUrl,
      openaiModel,
      ...(key.trim() ? { apiKey: key.trim() } : {}),
    });
    if (key.trim()) {
      setSavedKeys((current) => ({ ...current, [provider]: true }));
      setKey('');
    }
  };
  return (
    <Panel title="AI provider">
      <fieldset disabled={loading || operation.busy} className="min-w-0 space-y-4">
        <Field label="Provider">
          <Select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as AiProvider);
              setKey('');
            }}
            className="w-full sm:max-w-md"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI compatible (OpenAI, Gemini, OpenRouter, local)</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={
              <>
                API key {savedKeys[provider] && <Badge color="emerald">Saved on this device</Badge>}
              </>
            }
            hint="Leave this blank to keep the saved key."
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste a key to add or replace it"
            />
          </Field>
          {provider === 'anthropic' ? (
            <Field label="Model">
              <Select
                value={anthropicModel}
                onChange={(e) => setAnthropicModel(e.target.value)}
                className="w-full"
              >
                {ANTHROPIC_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
                {!ANTHROPIC_MODELS.some((m) => m.id === anthropicModel) && (
                  <option value={anthropicModel}>{anthropicModel}</option>
                )}
              </Select>
            </Field>
          ) : (
            <Field label="Model name">
              <TextInput
                value={openaiModel}
                onChange={(e) => setOpenaiModel(e.target.value)}
                placeholder="Model supported by your provider"
              />
            </Field>
          )}
        </div>
        {provider === 'openai' && (
          <>
            <Field
              label="Provider endpoint"
              hint="Use the endpoint supplied by your provider. Local endpoints must allow this browser."
            >
              <TextInput
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                list="ai-endpoints"
              />
            </Field>
            <datalist id="ai-endpoints">
              {OPENAI_COMPAT_PRESETS.map((preset) => (
                <option key={preset.baseUrl} value={preset.baseUrl}>
                  {preset.label}
                </option>
              ))}
            </datalist>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => void operation.run(save, 'Provider settings saved on this device.')}
          >
            Save provider
          </Button>
          <Button
            onClick={() =>
              void operation.run(async () => {
                await save();
                operation.setMessage(await testConnection());
              })
            }
          >
            Save & test connection
          </Button>
          {savedKeys[provider] && (
            <Button
              variant="ghost"
              onClick={() =>
                void operation.run(async () => {
                  if (provider === 'anthropic') await setAnthropicKey('');
                  else await setOpenaiKey('');
                  setSavedKeys((current) => ({ ...current, [provider]: false }));
                }, 'Saved key removed.')
              }
            >
              Remove saved key
            </Button>
          )}
        </div>
      </fieldset>
      <Status {...operation} />
      <p className="mt-4 max-w-3xl text-sm text-slate-500">
        AI requests go directly from this browser to your chosen provider. Provider keys and
        destinations stay on this device and are excluded from study backups. Testing sends a short
        request to the provider.
      </p>
      <details className="mt-3 text-sm text-slate-400">
        <summary className="cursor-pointer">Use an external assistant instead</summary>
        <p className="mt-2">
          Connect the assistant's SRS tool to an exchange folder, then connect the same folder in
          Inbox. You can import its course and item drafts without adding an API key here.
        </p>
      </details>
    </Panel>
  );
}
