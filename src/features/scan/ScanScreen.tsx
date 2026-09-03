import { ManualEntry } from "./ManualEntry";

/**
 * S0 ships this screen in manual-entry mode only: no video element and no camera
 * permission request until the S1 scanner lands. Typing runs the same §4.2 → §4.3 → §5.3
 * path the scanner will, so nothing downstream changes when the camera arrives.
 */
export function ScanScreen() {
  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-6 p-4 pb-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-bold text-fg">Add a VIN</h1>
        <p className="text-base leading-snug text-fg-muted">
          Camera scanning isn&rsquo;t in this build yet. Type or paste the VIN from the door jamb
          label — spaces and a leading I are fine.
        </p>
      </header>
      <ManualEntry />
    </section>
  );
}

export default ScanScreen;
