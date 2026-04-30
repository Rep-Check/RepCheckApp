"use client"

import { useState } from "react"
import { Header } from "@/components/pocket-pt/header"
import { BottomNav } from "@/components/pocket-pt/bottom-nav"
import { HomeScreen } from "@/components/pocket-pt/screens/home-screen"
import { ExerciseScreen } from "@/components/pocket-pt/screens/exercise-screen"
import { ResultsScreen } from "@/components/pocket-pt/screens/results-screen"
import { ProgressScreen } from "@/components/pocket-pt/screens/progress-screen"

type Screen = "home" | "exercise" | "results" | "progress"

export default function PocketPT() {
  const [activeScreen, setActiveScreen] = useState<Screen>("home")
  const [selectedExercise, setSelectedExercise] = useState<string>("")

  const handleAnalyse = () => {
    setActiveScreen("exercise")
  }

  const handleSelectExercise = (exercise: string) => {
    setSelectedExercise(exercise)
    setActiveScreen("results")
  }

  const handleViewResult = () => {
    setSelectedExercise("Squat")
    setActiveScreen("results")
  }

  const handleBack = () => {
    if (activeScreen === "results") {
      setActiveScreen("exercise")
    } else if (activeScreen === "exercise") {
      setActiveScreen("home")
    } else {
      setActiveScreen("home")
    }
  }

  const renderScreen = () => {
    switch (activeScreen) {
      case "home":
        return (
          <HomeScreen 
            onAnalyse={handleAnalyse} 
            onViewResult={handleViewResult}
          />
        )
      case "exercise":
        return (
          <ExerciseScreen 
            onBack={handleBack}
            onSelectExercise={handleSelectExercise}
          />
        )
      case "results":
        return (
          <ResultsScreen 
            exercise={selectedExercise}
            onBack={handleBack}
          />
        )
      case "progress":
        return <ProgressScreen />
      default:
        return (
          <HomeScreen 
            onAnalyse={handleAnalyse} 
            onViewResult={handleViewResult}
          />
        )
    }
  }

  return (
    <div className="min-h-screen bg-background max-w-md mx-auto relative">
      {/* Mobile device frame simulation */}
      <div className="flex flex-col min-h-screen">
        <Header />
        
        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto">
          {renderScreen()}
        </main>

        {/* Bottom Navigation */}
        <BottomNav 
          activeScreen={activeScreen} 
          onNavigate={setActiveScreen}
        />
      </div>
    </div>
  )
}
