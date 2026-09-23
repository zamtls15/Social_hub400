import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircleIcon, CheckCircle2Icon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fetchJson } from "@/lib/api";
import { usePrefsStore, type ThemePref } from "@/lib/prefs";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RuntimeSetting = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: "string" | "number" | "boolean" | "url" | "secret";
  value: unknown;
  source: "environment" | "stored";
  requiresRestart: boolean;
  secret: boolean;
};

type SettingsResponse = { ok: boolean; settings: RuntimeSetting[]; error?: string };

function inputValue(setting: RuntimeSetting): string {
  if (setting.type === "boolean") return String(Boolean(setting.value));
  return setting.value == null ? "" : String(setting.value);
}

export function SettingsPage() {
  const autoplay = usePrefsStore((s) => s.autoplay);
  const theme = usePrefsStore((s) => s.theme);
  const setAutoplay = usePrefsStore((s) => s.setAutoplay);
  const setPrefTheme = usePrefsStore((s) => s.setTheme);
  const { setTheme } = useTheme();
  const [settings, setSettings] = useState<RuntimeSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await fetchJson<SettingsResponse>("/api/settings");
      setSettings(result.settings);
      setDrafts(Object.fromEntries(result.settings.map((setting) => [setting.key, inputValue(setting)])));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Couldn’t load settings right now — try again in a moment." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => {
    const groups = new Map<string, RuntimeSetting[]>();
    for (const setting of settings) {
      const items = groups.get(setting.group) ?? [];
      items.push(setting);
      groups.set(setting.group, items);
    }
    return [...groups.entries()];
  }, [settings]);

  async function save(setting: RuntimeSetting) {
    setSaving(setting.key);
    setMessage(null);
    try {
      const result = await fetchJson<{ message: string; setting: RuntimeSetting }>(`/api/settings/${encodeURIComponent(setting.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: setting.type === "boolean" ? drafts[setting.key] === "true" : setting.type === "number" ? Number(drafts[setting.key]) : drafts[setting.key] }),
      });
      setSettings((current) => current.map((item) => item.key === setting.key ? result.setting : item));
      setDrafts((current) => ({ ...current, [setting.key]: inputValue(result.setting) }));
      setMessage({ kind: "success", text: `${setting.label}: ${result.message}` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Couldn’t save this right now — try again in a moment." });
    } finally {
      setSaving(null);
    }
  }

  async function reset(setting: RuntimeSetting) {
    setSaving(setting.key);
    setMessage(null);
    try {
      const result = await fetchJson<{ message: string; setting: RuntimeSetting }>(`/api/settings/${encodeURIComponent(setting.key)}`, { method: "DELETE" });
      setSettings((current) => current.map((item) => item.key === setting.key ? result.setting : item));
      setDrafts((current) => ({ ...current, [setting.key]: inputValue(result.setting) }));
      setMessage({ kind: "success", text: `${setting.label}: ${result.message}` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Couldn’t reset this right now — try again in a moment." });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Runtime settings</CardTitle>
          <CardDescription>
            These values control the server integrations. Environment values are used by default; a saved value overrides its environment value.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {message ? (
            <div className={message.kind === "success" ? "flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800" : "flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"} role="status">
              {message.kind === "success" ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" /> : <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />}
              <span>{message.text}</span>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Full values are shown because this is a test environment. Secure this page before deploying it publicly.
          </p>
        </CardContent>
      </Card>

      {loading ? <Card><CardContent className="py-8 text-sm text-muted-foreground">Loading server settings…</CardContent></Card> : null}
      {!loading && grouped.map(([group, items]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{group}</CardTitle>
            <CardDescription>Connection and behavior settings for {group}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {items.map((setting) => (
              <div key={setting.key} className="space-y-2 border-b pb-5 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={setting.key}>{setting.label}</Label>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{setting.source === "stored" ? "Saved override" : "Environment default"}</Badge>
                    {setting.requiresRestart ? <Badge variant="secondary">Requires restart</Badge> : <Badge variant="secondary">Live now</Badge>}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{setting.description}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {setting.type === "boolean" ? (
                    <div className="flex h-10 items-center gap-3">
                      <Switch id={setting.key} checked={drafts[setting.key] === "true"} onCheckedChange={(checked) => setDrafts((current) => ({ ...current, [setting.key]: String(checked) }))} />
                      <span className="text-sm">{drafts[setting.key] === "true" ? "Yes" : "No"}</span>
                    </div>
                  ) : setting.key === "SC_MODE" ? (
                    <Select value={drafts[setting.key] ?? "cache"} onValueChange={(value) => setDrafts((current) => ({ ...current, [setting.key]: value }))}>
                      <SelectTrigger id={setting.key} className="sm:max-w-xs"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="cache">Cache when possible</SelectItem><SelectItem value="offline">Offline fixtures only</SelectItem><SelectItem value="live">Always use live API</SelectItem></SelectContent>
                    </Select>
                  ) : (
                    <Input id={setting.key} type={setting.type === "number" ? "number" : "text"} value={drafts[setting.key] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))} className="font-mono" />
                  )}
                  <Button type="button" onClick={() => void save(setting)} disabled={saving !== null}>
                    <SaveIcon className="size-4" /> {saving === setting.key ? "Saving…" : "Save"}
                  </Button>
                  {setting.source === "stored" ? <Button type="button" variant="outline" onClick={() => void reset(setting)} disabled={saving !== null} title="Remove the saved override and use the environment default"><RotateCcwIcon className="size-4" /> Use default</Button> : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>These preferences stay in this browser and do not change server behavior.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label htmlFor="theme">Theme</Label><Select value={theme} onValueChange={(value) => { const next = value as ThemePref; setPrefTheme(next); setTheme(next); }}><SelectTrigger id="theme" className="w-full max-w-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem><SelectItem value="system">System</SelectItem></SelectContent></Select></div>
          <div className="flex items-center justify-between gap-4"><Label htmlFor="autoplay">Autoplay videos</Label><Switch id="autoplay" checked={autoplay} onCheckedChange={setAutoplay} /></div>
        </CardContent>
      </Card>
    </div>
  );
}
