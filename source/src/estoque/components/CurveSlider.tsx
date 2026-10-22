import * as SliderPrimitive from "@radix-ui/react-slider";
export function CurveSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <SliderPrimitive.Root
      min={0}
      max={100}
      step={1}
      value={[value]}
      onValueChange={(v) => onChange(v[0] ?? 0)}
      className="relative flex min-h-11 w-full touch-none select-none items-center"
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        className="block size-5 rounded-full border-2 border-primary bg-background focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      />
    </SliderPrimitive.Root>
  );
}
