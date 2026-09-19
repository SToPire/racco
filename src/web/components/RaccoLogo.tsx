const lightLogo = new URL(
  "../../../assets/brand/racco/racco-logo.svg",
  import.meta.url,
).href;
const darkLogo = new URL(
  "../../../assets/brand/racco/racco-logo-dark.svg",
  import.meta.url,
).href;

export function RaccoLogo({ className = "" }: { className?: string }) {
  return (
    <picture className={`racco-logo ${className}`}>
      <source media="(prefers-color-scheme: dark)" srcSet={darkLogo} />
      <img src={lightLogo} alt="Racco" width={896} height={256} />
    </picture>
  );
}
