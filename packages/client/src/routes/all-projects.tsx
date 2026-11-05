import { createFileRoute } from "@tanstack/react-router"
import { AllProjectsPage } from "../components/all-projects-page"

export const Route = createFileRoute("/all-projects")({ component: AllProjectsPage })
