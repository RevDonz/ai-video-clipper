export default function Brand({ href = "/", className = "" }) {
  return (
    <a className={className ? `brand ${className}` : "brand"} href={href}>
      <span aria-hidden="true">P</span>
      Potongin AI
    </a>
  );
}
