import { ThemeProvider } from "./components/ThemeContext";
import { TodoList } from "./components/TodoList";
import { Clock } from "./components/Clock";

export default function App() {
  return (
    <ThemeProvider>
      <Clock tickMs={1000} />
      <TodoList initial={[{ id: "1", title: "Port to Solid!", done: false }, { id: "2", title: "Write specs", done: true }]} />
    </ThemeProvider>
  );
}
