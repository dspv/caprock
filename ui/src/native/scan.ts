/**
 * Pairing by the iPhone's camera (ADR-083): the official Capacitor barcode
 * scanner reads the QR code the computer shows — the same pairing link the
 * phone's page reads — so no step goes through Safari.
 */
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner'

/** What a scan came back with: the code's text, a closed scanner, or why it failed. */
export type Scan = { text: string } | { cancelled: true } | { error: string }

/** The plugin's error codes (OSBarcodeError.swift): 6 cancelled, 7 camera refused. */
export function scanFailure(e: unknown): Scan {
  const code = String((e as { code?: unknown })?.code ?? '')
  if (code.endsWith('0006')) return { cancelled: true }
  if (code.endsWith('0007')) return { error: 'Caprock may not use the camera. Allow it in Settings → Caprock → Camera, or paste the link instead.' }
  return { error: 'The camera could not read a code. Try again, or paste the link instead.' }
}

export async function scanCode(): Promise<Scan> {
  try {
    const r = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Scan the code on your Mac. The camera only reads the code; nothing is recorded.',
      scanButton: false,
      cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
      scanOrientation: CapacitorBarcodeScannerScanOrientation.PORTRAIT,
      cancelButtonAccessibilityLabel: 'Cancel',
      torchButtonOnAccessibilityLabel: 'Torch on',
      torchButtonOffAccessibilityLabel: 'Torch off',
    })
    return r.ScanResult ? { text: r.ScanResult } : { cancelled: true }
  } catch (e) {
    return scanFailure(e)
  }
}
