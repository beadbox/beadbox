import { createFileRoute } from "@tanstack/react-router"
import { ChartView } from "../components/chart-view"

export const Route = createFileRoute("/chart")({
  component: ChartView,
})
