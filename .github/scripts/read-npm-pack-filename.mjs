#!/usr/bin/env node

import process from 'node:process'

let input = ''
for await (const chunk of process.stdin) input += chunk

let result
try {
  result = JSON.parse(input)
} catch {
  console.error('npm pack did not return valid JSON')
  process.exit(1)
}

if (!Array.isArray(result) || result.length !== 1) {
  console.error(`npm pack returned ${Array.isArray(result) ? result.length : 'non-array'} results`)
  process.exit(1)
}

const filename = result[0]?.filename
if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(filename)) {
  console.error('npm pack returned an unsafe filename')
  process.exit(1)
}

process.stdout.write(filename)
