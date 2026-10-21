export default function App() {
  const greeting = "Hello from NeoSolver";
  const hostile = `quotes: 'single' and "double"`;
  return (
    <main className="app">
      <h1>{greeting}</h1>
      <p>{hostile}</p>
      <p>EOF</p>
      <p>NEO_EOF_1</p>
    </main>
  );
}
