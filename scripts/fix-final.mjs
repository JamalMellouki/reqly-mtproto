import { readFileSync, writeFileSync } from "node:fs"

const path = new URL("../scripts/aes-ige-t.wat", import.meta.url)
let text = readFileSync(path, "utf8")

function sbox(table, wordExpr) {
  const byte = (shift) => `(i32.and (i32.shr_u ${wordExpr} (i32.const ${shift})) (i32.const 255))`
  return `(i32.load8_u (i32.add (i32.const ${table}) ${byte(24)}))`
}

function finalWord(table, parts) {
  let value = ""
  for (let i = 0; i < parts.length; i += 1) {
    const piece = `(i32.shl ${sbox(table, parts[i].word)} (i32.const ${24 - i * 8}))`
    value = value ? `(i32.or ${value} ${piece})` : piece
  }
  return value
}

const enc = [
  [["w0", 24], ["w1", 16], ["w2", 8], ["w3", 0]],
  [["w1", 24], ["w2", 16], ["w3", 8], ["w0", 0]],
  [["w2", 24], ["w3", 16], ["w0", 8], ["w1", 0]],
  [["w3", 24], ["w0", 16], ["w1", 8], ["w2", 0]],
]
  .map((parts, index) => {
    let value = ""
    for (let i = 0; i < parts.length; i += 1) {
      const [name, shift] = parts[i]
      const piece = `(i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $${name}) (i32.const ${shift})) (i32.const 255)))) (i32.const ${24 - i * 8}))`
      value = value ? `(i32.or ${value} ${piece})` : piece
    }
    return `    (i32.store (i32.const ${0x0900 + index * 4}) (i32.xor ${value} (i32.load (i32.const ${0x08e0 + index * 4}))))`
  })
  .join("\n")

const dec = [
  [["w0", 24], ["w3", 16], ["w2", 8], ["w1", 0]],
  [["w1", 24], ["w0", 16], ["w3", 8], ["w2", 0]],
  [["w2", 24], ["w1", 16], ["w0", 8], ["w3", 0]],
  [["w3", 24], ["w2", 16], ["w1", 8], ["w0", 0]],
]
  .map((parts, index) => {
    let value = ""
    for (let i = 0; i < parts.length; i += 1) {
      const [name, shift] = parts[i]
      const piece = `(i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $${name}) (i32.const ${shift})) (i32.const 255)))) (i32.const ${24 - i * 8}))`
      value = value ? `(i32.or ${value} ${piece})` : piece
    }
    return `    (i32.store (i32.const ${0x0900 + index * 4}) (i32.xor ${value} (i32.load (i32.const ${0x0800 + index * 4}))))`
  })
  .join("\n")

text = text.replace(
  /    ;; final round: SubBytes[\s\S]*?\(i32\.store \(i32\.const 0x090c\) \(i32\.xor \(local\.get \$d\) \(i32\.load \(i32\.const 0x08fc\)\)\)\)/,
  `    ;; final round: SubBytes + ShiftRows + AddRoundKey(14)\n${enc}`,
)
text = text.replace(
  /    \(local\.set \$a \(i32\.or \(i32\.or[\s\S]*?\(i32\.store \(i32\.const 0x090c\) \(i32\.xor \(local\.get \$d\) \(i32\.load \(i32\.const 0x080c\)\)\)\)/,
  `    ;; final round: InvShiftRows + InvSubBytes + AddRoundKey(0)\n${dec}`,
)
writeFileSync(path, text)
console.log(JSON.stringify({ ok: true }))
