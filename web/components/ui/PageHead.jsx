// The head every app page opens with: its name and its actions, no sentence (05-ui-dashboard.md
// §2 P2). ui-guards rejects a <p> inside <PageHead>. Uses the shared .pageHead styles.
export default function PageHead({ title, id, children }) {
  return (
    <header className="pageHead">
      <h1 id={id}>{title}</h1>
      {children ? <div className="pageHeadActions">{children}</div> : null}
    </header>
  );
}
