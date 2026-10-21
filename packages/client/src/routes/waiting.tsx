import { createFileRoute } from "@tanstack/react-router"
import { WaitingPage } from "../components/waiting-page"

export const Route = createFileRoute("/waiting")({
  component: WaitingPage,
})
