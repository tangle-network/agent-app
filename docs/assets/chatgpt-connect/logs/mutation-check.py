from pathlib import Path
import subprocess
p=Path('src/chatgpt-react/index.tsx');original=p.read_text()
cases=[('scope-reset', 'key={key}', 'key="fixed"', 'drops setup and clipboard feedback'), ('false-connection', "const connected = state.status === 'connected'", 'const connected = true', 'opens supported setup'), ('registered-destination', "registeredUrl?.hostname === 'chatgpt.com' && !registeredUrl.port", 'registeredUrl', 'falls back to supported setup')]
cases += [('collapsed-details', '<details className=', '<details open className=', 'keeps native identifiers'), ('destination-label', " : 'Open ChatGPT plugins'", " : 'Open in ChatGPT'", 'renders host-confirmed state')]
try:
 for name,old,new,test in cases:
  assert old in original
  p.write_text(original.replace(old,new))
  result=subprocess.run(['pnpm','exec','vitest','run','src/chatgpt-react/connect.test.tsx','-t',test],capture_output=True,text=True)
  Path('/tmp/chatgpt-connect-evidence-20261002/mutation-'+name+'.log').write_text(result.stdout+result.stderr)
  assert result.returncode !=0, name+' did not fail'
  print(name+': rejected by test')
finally:
 p.write_text(original)
