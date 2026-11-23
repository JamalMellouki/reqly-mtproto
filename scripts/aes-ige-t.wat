;; reqly — AES-256-IGE with 32-bit T-tables (build-time WAT source).
;; Layout:
;;  0x0000 SBOX[256]   0x0100 INV[256]
;;  0x0800 round keys: 60 i32 words
;;  0x0900 state 4 words   0x0920 IV0   0x0930 IV1   0x0940 ORIG
;;  0x0A00 Te0[256] i32  0x0E00 Te1  0x1200 Te2  0x1600 Te3
;;  0x1A00 Td0[256] i32  0x1E00 Td1  0x2200 Td2  0x2600 Td3
;;  0x3000 data bytes
(module
  (memory (export "memory") 2)

  (func $encryptBlock (export "encryptBlock")
    (local $w0 i32) (local $w1 i32) (local $w2 i32) (local $w3 i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $round i32) (local $base i32)
    (local.set $w0 (i32.load (i32.const 0x0900)))
    (local.set $w1 (i32.load (i32.const 0x0904)))
    (local.set $w2 (i32.load (i32.const 0x0908)))
    (local.set $w3 (i32.load (i32.const 0x090c)))
    (local.set $w0 (i32.xor (local.get $w0) (i32.load (i32.const 0x0800))))
    (local.set $w1 (i32.xor (local.get $w1) (i32.load (i32.const 0x0804))))
    (local.set $w2 (i32.xor (local.get $w2) (i32.load (i32.const 0x0808))))
    (local.set $w3 (i32.xor (local.get $w3) (i32.load (i32.const 0x080c))))
    (local.set $round (i32.const 1))
    (block $outer (loop $loop
      (br_if $outer (i32.ge_u (local.get $round) (i32.const 14)))
      (local.set $base (i32.mul (local.get $round) (i32.const 16)))
      (local.set $a (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x0A00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x0E00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x1200) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x1600) (i32.shl (i32.and (local.get $w3) (i32.const 255)) (i32.const 2))))))
      (local.set $a (i32.xor (local.get $a) (i32.load (i32.add (i32.const 0x0800) (local.get $base)))))
      (local.set $b (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x0A00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x0E00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x1200) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x1600) (i32.shl (i32.and (local.get $w0) (i32.const 255)) (i32.const 2))))))
      (local.set $b (i32.xor (local.get $b) (i32.load (i32.add (i32.const 0x0804) (local.get $base)))))
      (local.set $c (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x0A00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x0E00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x1200) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x1600) (i32.shl (i32.and (local.get $w1) (i32.const 255)) (i32.const 2))))))
      (local.set $c (i32.xor (local.get $c) (i32.load (i32.add (i32.const 0x0808) (local.get $base)))))
      (local.set $d (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x0A00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x0E00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x1200) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x1600) (i32.shl (i32.and (local.get $w2) (i32.const 255)) (i32.const 2))))))
      (local.set $d (i32.xor (local.get $d) (i32.load (i32.add (i32.const 0x080c) (local.get $base)))))
      (local.set $w0 (local.get $a)) (local.set $w1 (local.get $b))
      (local.set $w2 (local.get $c)) (local.set $w3 (local.get $d))
      (local.set $round (i32.add (local.get $round) (i32.const 1)))
      (br $loop)
    ))
    ;; final round: SubBytes + ShiftRows + AddRoundKey(14)
    (i32.store (i32.const 2304) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w0) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w1) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w2) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w3) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2272))))
    (i32.store (i32.const 2308) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w1) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w2) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w3) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w0) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2276))))
    (i32.store (i32.const 2312) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w2) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w3) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w0) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w1) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2280))))
    (i32.store (i32.const 2316) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w3) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w0) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w1) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0000) (i32.and (i32.shr_u (local.get $w2) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2284))))
  )

  (func (export "debugDecrypt") (param $count i32)
    (local $w0 i32) (local $w1 i32) (local $w2 i32) (local $w3 i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $round i32) (local $base i32)
    (local.set $w0 (i32.xor (i32.load (i32.const 0x0900)) (i32.load (i32.const 0x0800))))
    (local.set $w1 (i32.xor (i32.load (i32.const 0x0904)) (i32.load (i32.const 0x0804))))
    (local.set $w2 (i32.xor (i32.load (i32.const 0x0908)) (i32.load (i32.const 0x0808))))
    (local.set $w3 (i32.xor (i32.load (i32.const 0x090c)) (i32.load (i32.const 0x080c))))
    (local.set $round (i32.const 13))
    (block $outer (loop $loop
      (br_if $outer (i32.lt_s (local.get $round) (i32.const 1)))
      (local.set $base (i32.mul (local.get $round) (i32.const 16)))
      (local.set $a (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w1) (i32.const 255)) (i32.const 2))))))
      (local.set $a (i32.xor (local.get $a) (i32.load (i32.add (i32.const 0x0800) (local.get $base)))))
      (local.set $b (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w2) (i32.const 255)) (i32.const 2))))))
      (local.set $b (i32.xor (local.get $b) (i32.load (i32.add (i32.const 0x0804) (local.get $base)))))
      (local.set $c (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w3) (i32.const 255)) (i32.const 2))))))
      (local.set $c (i32.xor (local.get $c) (i32.load (i32.add (i32.const 0x0808) (local.get $base)))))
      (local.set $d (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w0) (i32.const 255)) (i32.const 2))))))
      (local.set $d (i32.xor (local.get $d) (i32.load (i32.add (i32.const 0x080c) (local.get $base)))))
      (local.set $w0 (local.get $a)) (local.set $w1 (local.get $b))
      (local.set $w2 (local.get $c)) (local.set $w3 (local.get $d))
      (local.set $round (i32.sub (local.get $round) (i32.const 1)))
      (br $loop)
    ))
    (i32.store (i32.const 0x0900) (local.get $w0))
    (i32.store (i32.const 0x0904) (local.get $w1))
    (i32.store (i32.const 0x0908) (local.get $w2))
    (i32.store (i32.const 0x090c) (local.get $w3))
  )

  (func $decryptBlock (export "decryptBlock")
    (local $w0 i32) (local $w1 i32) (local $w2 i32) (local $w3 i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $round i32) (local $base i32)
    (local.set $w0 (i32.xor (i32.load (i32.const 0x0900)) (i32.load (i32.const 0x0800))))
    (local.set $w1 (i32.xor (i32.load (i32.const 0x0904)) (i32.load (i32.const 0x0804))))
    (local.set $w2 (i32.xor (i32.load (i32.const 0x0908)) (i32.load (i32.const 0x0808))))
    (local.set $w3 (i32.xor (i32.load (i32.const 0x090c)) (i32.load (i32.const 0x080c))))
    (local.set $round (i32.const 13))
    (block $outer (loop $loop
      (br_if $outer (i32.lt_s (local.get $round) (i32.const 1)))
      (local.set $base (i32.mul (local.get $round) (i32.const 16)))
      (local.set $a (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w1) (i32.const 255)) (i32.const 2))))))
      (local.set $a (i32.xor (local.get $a) (i32.load (i32.add (i32.const 0x0800) (local.get $base)))))
      (local.set $b (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w2) (i32.const 255)) (i32.const 2))))))
      (local.set $b (i32.xor (local.get $b) (i32.load (i32.add (i32.const 0x0804) (local.get $base)))))
      (local.set $c (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w0) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w3) (i32.const 255)) (i32.const 2))))))
      (local.set $c (i32.xor (local.get $c) (i32.load (i32.add (i32.const 0x0808) (local.get $base)))))
      (local.set $d (i32.xor
        (i32.xor
          (i32.xor
            (i32.load (i32.add (i32.const 0x1A00) (i32.shl (i32.and (i32.shr_u (local.get $w3) (i32.const 24)) (i32.const 255)) (i32.const 2))))
            (i32.load (i32.add (i32.const 0x1E00) (i32.shl (i32.and (i32.shr_u (local.get $w2) (i32.const 16)) (i32.const 255)) (i32.const 2)))))
          (i32.load (i32.add (i32.const 0x2200) (i32.shl (i32.and (i32.shr_u (local.get $w1) (i32.const 8)) (i32.const 255)) (i32.const 2)))))
        (i32.load (i32.add (i32.const 0x2600) (i32.shl (i32.and (local.get $w0) (i32.const 255)) (i32.const 2))))))
      (local.set $d (i32.xor (local.get $d) (i32.load (i32.add (i32.const 0x080c) (local.get $base)))))
      (local.set $w0 (local.get $a)) (local.set $w1 (local.get $b))
      (local.set $w2 (local.get $c)) (local.set $w3 (local.get $d))
      (local.set $round (i32.sub (local.get $round) (i32.const 1)))
      (br $loop)
    ))
    ;; final round: InvShiftRows + InvSubBytes + AddRoundKey(0)
    (i32.store (i32.const 2304) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w0) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w3) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w2) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w1) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2272))))
    (i32.store (i32.const 2308) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w1) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w0) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w3) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w2) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2276))))
    (i32.store (i32.const 2312) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w2) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w1) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w0) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w3) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2280))))
    (i32.store (i32.const 2316) (i32.xor (i32.or (i32.or (i32.or (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w3) (i32.const 24)) (i32.const 255)))) (i32.const 24)) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w2) (i32.const 16)) (i32.const 255)))) (i32.const 16))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w1) (i32.const 8)) (i32.const 255)))) (i32.const 8))) (i32.shl (i32.load8_u (i32.add (i32.const 0x0100) (i32.and (i32.shr_u (local.get $w0) (i32.const 0)) (i32.const 255)))) (i32.const 0))) (i32.load (i32.const 2284))))
  )

  (func (export "ige") (param $ptr i32) (param $len i32) (param $decrypt i32)
    (local $off i32) (local $i i32) (local $p i32) (local $a i32)
    (local.set $off (i32.const 0))
    (block $outer (loop $loop
      (br_if $outer (i32.ge_u (local.get $off) (local.get $len)))
      ;; state words <- big-endian bytes at ptr+off; ORIG <- same
      (local.set $i (i32.const 0))
      (block $bl (loop $ll
        (br_if $bl (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $p (i32.add (local.get $ptr) (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const 4)))))
        (local.set $a (i32.or (i32.or
          (i32.shl (i32.load8_u (local.get $p)) (i32.const 24))
          (i32.shl (i32.load8_u (i32.add (local.get $p) (i32.const 1))) (i32.const 16)))
          (i32.or
            (i32.shl (i32.load8_u (i32.add (local.get $p) (i32.const 2))) (i32.const 8))
            (i32.load8_u (i32.add (local.get $p) (i32.const 3))))))
        (i32.store (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4))) (local.get $a))
        (i32.store (i32.add (i32.const 0x0940) (i32.mul (local.get $i) (i32.const 4))) (local.get $a))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $ll)
      ))
      (if (local.get $decrypt)
        (then
          (local.set $i (i32.const 0))
          (block $bx (loop $lx
            (br_if $bx (i32.ge_u (local.get $i) (i32.const 4)))
            (i32.store (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))
              (i32.xor (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4))))
                       (i32.load (i32.add (i32.const 0x0930) (i32.mul (local.get $i) (i32.const 4))))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $lx)
          ))
          (call $decryptBlock)
          (local.set $i (i32.const 0))
          (block $by (loop $ly
            (br_if $by (i32.ge_u (local.get $i) (i32.const 4)))
            (i32.store (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))
              (i32.xor (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4))))
                       (i32.load (i32.add (i32.const 0x0920) (i32.mul (local.get $i) (i32.const 4))))))
            (i32.store (i32.add (i32.const 0x0920) (i32.mul (local.get $i) (i32.const 4)))
              (i32.load (i32.add (i32.const 0x0940) (i32.mul (local.get $i) (i32.const 4)))))
            (i32.store (i32.add (i32.const 0x0930) (i32.mul (local.get $i) (i32.const 4)))
              (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ly)
          ))
        )
        (else
          (local.set $i (i32.const 0))
          (block $bx (loop $lx
            (br_if $bx (i32.ge_u (local.get $i) (i32.const 4)))
            (i32.store (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))
              (i32.xor (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4))))
                       (i32.load (i32.add (i32.const 0x0920) (i32.mul (local.get $i) (i32.const 4))))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $lx)
          ))
          (call $encryptBlock)
          (local.set $i (i32.const 0))
          (block $by (loop $ly
            (br_if $by (i32.ge_u (local.get $i) (i32.const 4)))
            (i32.store (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))
              (i32.xor (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4))))
                       (i32.load (i32.add (i32.const 0x0930) (i32.mul (local.get $i) (i32.const 4))))))
            (i32.store (i32.add (i32.const 0x0920) (i32.mul (local.get $i) (i32.const 4)))
              (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))))
            (i32.store (i32.add (i32.const 0x0930) (i32.mul (local.get $i) (i32.const 4)))
              (i32.load (i32.add (i32.const 0x0940) (i32.mul (local.get $i) (i32.const 4)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ly)
          ))
        )
      )
      ;; write state words back as big-endian bytes
      (local.set $i (i32.const 0))
      (block $bw (loop $lw
        (br_if $bw (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $p (i32.add (local.get $ptr) (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const 4)))))
        (local.set $a (i32.load (i32.add (i32.const 0x0900) (i32.mul (local.get $i) (i32.const 4)))))
        (i32.store8 (local.get $p) (i32.and (i32.shr_u (local.get $a) (i32.const 24)) (i32.const 255)))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.and (i32.shr_u (local.get $a) (i32.const 16)) (i32.const 255)))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 255)))
        (i32.store8 (i32.add (local.get $p) (i32.const 3)) (i32.and (local.get $a) (i32.const 255)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lw)
      ))
      (local.set $off (i32.add (local.get $off) (i32.const 16)))
      (br $loop)
    ))
  )

)
