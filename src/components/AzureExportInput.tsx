import { useRef, useState } from 'react';
import { AZURE_IMPORT_COMMANDS } from '../lib/importAzure';

/** The commands that export an Azure network, and a box to paste their output into. */
export function AzureExportInput(props: { value: string; onChange: (value: string) => void }) {
  const [source, setSource] = useState(AZURE_IMPORT_COMMANDS[0].id);
  const [copied, setCopied] = useState(false);
  const command = AZURE_IMPORT_COMMANDS.find((c) => c.id === source) ?? AZURE_IMPORT_COMMANDS[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div className="tabs import-sources">
        {AZURE_IMPORT_COMMANDS.map((c) => (
          <button key={c.id} className={source === c.id ? 'active' : ''} onClick={() => setSource(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="muted">
        Exports the VNets and Virtual WAN hubs in {command.scope}. {command.hint}
      </p>
      <div className="command">
        <code>{command.command}</code>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <textarea
        className="code import-input"
        placeholder="Paste the JSON output here"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </>
  );
}

/** A button that reads a text file the user picks. */
export function LoadFileButton(props: { onLoad: (text: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json,text/plain"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) props.onLoad(await file.text());
        }}
      />
      <button onClick={() => fileInput.current?.click()}>Load file…</button>
    </>
  );
}
