import { SandboxClient } from '@tangle-network/sandbox'
const client = new SandboxClient({ apiKey: process.env.SANDBOX_API_KEY, baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools' })
const box = await client.get('sandbox-f5546a7a052f')
const script = `
for f in $HOME/.config/opencode/opencode.json $HOME/.config/opencode/opencode.jsonc; do
  if [ -f "$f" ]; then echo "== $f"; sed -e 's/proxy-model-token[^"]*/REDACTED/g' -e 's/sk-[A-Za-z0-9_-]*/REDACTED/g' "$f" | head -50; fi
done
echo ===RUNTIME-FILES
ls $HOME/.opencode* /tmp/opencode* 2>/dev/null | head -8
`
const r = await box.exec(script)
console.log(r.stdout.slice(0, 3000))
console.log('exit', r.exitCode)
