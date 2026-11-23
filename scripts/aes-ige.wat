;; reqly — embedded AES-256-IGE engine.
;; Build-time source only. Compiled to a WASM binary and embedded as base64 in
;; src/embedded-wasm.ts; there is no runtime file or external dependency.
;;
;; Memory layout (all offsets are byte offsets):
;;   0x0000  256-byte forward S-box
;;   0x0100  256-byte inverse S-box
;;   0x0200  gf2[256]
;;   0x0300  gf3[256]
;;   0x0400  gf9[256]
;;   0x0500  gf11[256]
;;   0x0600  gf13[256]
;;   0x0700  gf14[256]
;;   0x0800  240-byte AES-256 round keys (15 rounds x 16 bytes)
;;   0x0900  16-byte state
;;   0x0910  16-byte temp block (original input)
;;   0x0920  IV0 (previous ciphertext)
;;   0x0930  IV1 (previous plaintext)
(module
  (memory (export "memory") 2)

  (func $addRoundKey (param $round i32)
    (local $c i32) (local $r i32) (local $idx i32) (local $base i32)
    (local.set $base (i32.mul (local.get $round) (i32.const 16)))
    (local.set $c (i32.const 0))
    (block $bc (loop $lc
      (br_if $bc (i32.ge_u (local.get $c) (i32.const 4)))
      (local.set $r (i32.const 0))
      (block $br (loop $lr
        (br_if $br (i32.ge_u (local.get $r) (i32.const 4)))
        (local.set $idx (i32.add (i32.mul (local.get $c) (i32.const 4)) (local.get $r)))
        (i32.store8
          (i32.add (i32.const 0x0900) (local.get $idx))
          (i32.xor
            (i32.load8_u (i32.add (i32.const 0x0900) (local.get $idx)))
            (i32.load8_u (i32.add (i32.const 0x0800) (i32.add (local.get $base) (local.get $idx))))))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $lr)
      ))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br $lc)
    ))
  )

  (func $subBytes (param $table i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $b (loop $l
      (br_if $b (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store8
        (i32.add (i32.const 0x0900) (local.get $i))
        (i32.load8_u
          (i32.add (local.get $table)
            (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)
    ))
  )

  (func $copyStateToTemp
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $b (loop $l
      (br_if $b (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store8
        (i32.add (i32.const 0x0910) (local.get $i))
        (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)
    ))
  )

  (func $shiftRows
    (local $r i32) (local $c i32) (local $src i32) (local $dst i32)
    (call $copyStateToTemp)
    (local.set $r (i32.const 1))
    (block $br (loop $lr
      (br_if $br (i32.ge_u (local.get $r) (i32.const 4)))
      (local.set $c (i32.const 0))
      (block $bc (loop $lc
        (br_if $bc (i32.ge_u (local.get $c) (i32.const 4)))
        (local.set $src (i32.add (i32.mul (i32.add (local.get $c) (local.get $r)) (i32.const 4)) (i32.const 0)))
        (local.set $src (i32.add (local.get $src) (local.get $r)))
        (local.set $src (i32.and (local.get $src) (i32.const 15)))
        ;; reconstruct: ((c+r) mod 4)*4 + r
        (local.set $src (i32.add (i32.mul (i32.rem_u (i32.add (local.get $c) (local.get $r)) (i32.const 4)) (i32.const 4)) (local.get $r)))
        (local.set $dst (i32.add (i32.mul (local.get $c) (i32.const 4)) (local.get $r)))
        (i32.store8
          (i32.add (i32.const 0x0900) (local.get $dst))
          (i32.load8_u (i32.add (i32.const 0x0910) (local.get $src))))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $lc)
      ))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $lr)
    ))
  )

  (func $inverseShiftRows
    (local $r i32) (local $c i32) (local $src i32) (local $dst i32)
    (call $copyStateToTemp)
    (local.set $r (i32.const 1))
    (block $br (loop $lr
      (br_if $br (i32.ge_u (local.get $r) (i32.const 4)))
      (local.set $c (i32.const 0))
      (block $bc (loop $lc
        (br_if $bc (i32.ge_u (local.get $c) (i32.const 4)))
        (local.set $src (i32.add (i32.mul (i32.rem_u (i32.add (i32.add (local.get $c) (i32.const 4)) (i32.sub (i32.const 0) (local.get $r))) (i32.const 4)) (i32.const 4)) (local.get $r)))
        (local.set $dst (i32.add (i32.mul (local.get $c) (i32.const 4)) (local.get $r)))
        (i32.store8
          (i32.add (i32.const 0x0900) (local.get $dst))
          (i32.load8_u (i32.add (i32.const 0x0910) (local.get $src))))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $lc)
      ))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $lr)
    ))
  )

  (func $mixColumns
    (local $col i32) (local $o i32) (local $a0 i32) (local $a1 i32) (local $a2 i32) (local $a3 i32)
    (call $copyStateToTemp)
    (local.set $col (i32.const 0))
    (block $b (loop $l
      (br_if $b (i32.ge_u (local.get $col) (i32.const 4)))
      (local.set $o (i32.mul (local.get $col) (i32.const 4)))
      (local.set $a0 (i32.load8_u (i32.add (i32.const 0x0910) (local.get $o))))
      (local.set $a1 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 1)))))
      (local.set $a2 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 2)))))
      (local.set $a3 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (local.get $o))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0200) (local.get $a0)))
          (i32.load8_u (i32.add (i32.const 0x0300) (local.get $a1))))
          (local.get $a2)) (local.get $a3)))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 1)))
        (i32.xor (i32.xor (i32.xor
          (local.get $a0)
          (i32.load8_u (i32.add (i32.const 0x0200) (local.get $a1))))
          (i32.load8_u (i32.add (i32.const 0x0300) (local.get $a2))))
          (local.get $a3)))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 2)))
        (i32.xor (i32.xor (i32.xor
          (local.get $a0) (local.get $a1))
          (i32.load8_u (i32.add (i32.const 0x0200) (local.get $a2))))
          (i32.load8_u (i32.add (i32.const 0x0300) (local.get $a3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 3)))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0300) (local.get $a0)))
          (local.get $a1)) (local.get $a2))
          (i32.load8_u (i32.add (i32.const 0x0200) (local.get $a3)))))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $l)
    ))
  )

  (func $inverseMixColumns
    (local $col i32) (local $o i32) (local $a0 i32) (local $a1 i32) (local $a2 i32) (local $a3 i32)
    (call $copyStateToTemp)
    (local.set $col (i32.const 0))
    (block $b (loop $l
      (br_if $b (i32.ge_u (local.get $col) (i32.const 4)))
      (local.set $o (i32.mul (local.get $col) (i32.const 4)))
      (local.set $a0 (i32.load8_u (i32.add (i32.const 0x0910) (local.get $o))))
      (local.set $a1 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 1)))))
      (local.set $a2 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 2)))))
      (local.set $a3 (i32.load8_u (i32.add (i32.const 0x0910) (i32.add (local.get $o) (i32.const 3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (local.get $o))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0700) (local.get $a0)))
          (i32.load8_u (i32.add (i32.const 0x0500) (local.get $a1))))
          (i32.load8_u (i32.add (i32.const 0x0600) (local.get $a2))))
          (i32.load8_u (i32.add (i32.const 0x0400) (local.get $a3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 1)))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0400) (local.get $a0)))
          (i32.load8_u (i32.add (i32.const 0x0700) (local.get $a1))))
          (i32.load8_u (i32.add (i32.const 0x0500) (local.get $a2))))
          (i32.load8_u (i32.add (i32.const 0x0600) (local.get $a3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 2)))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0600) (local.get $a0)))
          (i32.load8_u (i32.add (i32.const 0x0400) (local.get $a1))))
          (i32.load8_u (i32.add (i32.const 0x0700) (local.get $a2))))
          (i32.load8_u (i32.add (i32.const 0x0500) (local.get $a3)))))
      (i32.store8 (i32.add (i32.const 0x0900) (i32.add (local.get $o) (i32.const 3)))
        (i32.xor (i32.xor (i32.xor
          (i32.load8_u (i32.add (i32.const 0x0500) (local.get $a0)))
          (i32.load8_u (i32.add (i32.const 0x0600) (local.get $a1))))
          (i32.load8_u (i32.add (i32.const 0x0400) (local.get $a2))))
          (i32.load8_u (i32.add (i32.const 0x0700) (local.get $a3)))))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $l)
    ))
  )

  (func $encryptBlock
    (local $round i32)
    (call $addRoundKey (i32.const 0))
    (local.set $round (i32.const 1))
    (block $outer (loop $loop
      (br_if $outer (i32.ge_u (local.get $round) (i32.const 14)))
      (call $subBytes (i32.const 0x0000))
      (call $shiftRows)
      (call $mixColumns)
      (call $addRoundKey (local.get $round))
      (local.set $round (i32.add (local.get $round) (i32.const 1)))
      (br $loop)
    ))
    (call $subBytes (i32.const 0x0000))
    (call $shiftRows)
    (call $addRoundKey (i32.const 14))
  )

  (func $decryptBlock
    (local $round i32)
    (call $addRoundKey (i32.const 14))
    (local.set $round (i32.const 13))
    (block $outer (loop $loop
      (br_if $outer (i32.lt_s (local.get $round) (i32.const 1)))
      (call $inverseShiftRows)
      (call $subBytes (i32.const 0x0100))
      (call $addRoundKey (local.get $round))
      (call $inverseMixColumns)
      (local.set $round (i32.sub (local.get $round) (i32.const 1)))
      (br $loop)
    ))
    (call $inverseShiftRows)
    (call $subBytes (i32.const 0x0100))
    (call $addRoundKey (i32.const 0))
  )

  ;; In-place IGE over `len` bytes at `ptr`. IV0 at 0x0920, IV1 at 0x0930.
  ;; `decrypt` = 0 encrypts, 1 decrypts.
  (func (export "ige") (param $ptr i32) (param $len i32) (param $decrypt i32)
    (local $off i32) (local $i i32)
    (local.set $off (i32.const 0))
    (block $outer (loop $loop
      (br_if $outer (i32.ge_u (local.get $off) (local.get $len)))
      ;; temp <- ciphertext/plaintext block; state <- temp
      (local.set $i (i32.const 0))
      (block $b1 (loop $l1
        (br_if $b1 (i32.ge_u (local.get $i) (i32.const 16)))
        (i32.store8 (i32.add (i32.const 0x0940) (local.get $i))
          (i32.load8_u (i32.add (local.get $ptr) (i32.add (local.get $off) (local.get $i)))))
        (i32.store8 (i32.add (i32.const 0x0900) (local.get $i))
          (i32.load8_u (i32.add (i32.const 0x0940) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l1)
      ))
      (if (local.get $decrypt)
        (then
          ;; state ^= prevPlain
          (local.set $i (i32.const 0))
          (block $bd1 (loop $ld1
            (br_if $bd1 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0900) (local.get $i))
              (i32.xor
                (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i)))
                (i32.load8_u (i32.add (i32.const 0x0930) (local.get $i)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ld1)
          ))
          (call $decryptBlock)
          ;; state ^= prevCipher
          (local.set $i (i32.const 0))
          (block $bd2 (loop $ld2
            (br_if $bd2 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0900) (local.get $i))
              (i32.xor
                (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i)))
                (i32.load8_u (i32.add (i32.const 0x0920) (local.get $i)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ld2)
          ))
          ;; IV0 <- original ciphertext (temp), IV1 <- plaintext (state)
          (local.set $i (i32.const 0))
          (block $bd3 (loop $ld3
            (br_if $bd3 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0920) (local.get $i))
              (i32.load8_u (i32.add (i32.const 0x0940) (local.get $i))))
            (i32.store8 (i32.add (i32.const 0x0930) (local.get $i))
              (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ld3)
          ))
        )
        (else
          ;; state ^= prevCipher
          (local.set $i (i32.const 0))
          (block $be1 (loop $le1
            (br_if $be1 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0900) (local.get $i))
              (i32.xor
                (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i)))
                (i32.load8_u (i32.add (i32.const 0x0920) (local.get $i)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $le1)
          ))
          (call $encryptBlock)
          ;; state ^= prevPlain
          (local.set $i (i32.const 0))
          (block $be2 (loop $le2
            (br_if $be2 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0900) (local.get $i))
              (i32.xor
                (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i)))
                (i32.load8_u (i32.add (i32.const 0x0930) (local.get $i)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $le2)
          ))
          ;; IV0 <- ciphertext (state), IV1 <- original plaintext (temp)
          (local.set $i (i32.const 0))
          (block $be3 (loop $le3
            (br_if $be3 (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store8 (i32.add (i32.const 0x0920) (local.get $i))
              (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i))))
            (i32.store8 (i32.add (i32.const 0x0930) (local.get $i))
              (i32.load8_u (i32.add (i32.const 0x0940) (local.get $i))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $le3)
          ))
        )
      )
      ;; write state back
      (local.set $i (i32.const 0))
      (block $bw (loop $lw
        (br_if $bw (i32.ge_u (local.get $i) (i32.const 16)))
        (i32.store8 (i32.add (local.get $ptr) (i32.add (local.get $off) (local.get $i)))
          (i32.load8_u (i32.add (i32.const 0x0900) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lw)
      ))
      (local.set $off (i32.add (local.get $off) (i32.const 16)))
      (br $loop)
    ))
  )
)
