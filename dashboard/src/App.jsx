import { Routes, Route } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ComputerDetails from './components/ComputerDetails'
import Avisos from './components/Avisos'
import MaintenanceSchedules from './components/MaintenanceSchedules'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/avisos" element={<Avisos />} />
      <Route path="/manutencao-programada" element={<MaintenanceSchedules />} />
      <Route path="/computadores/:id" element={<ComputerDetails />} />
    </Routes>
  )
}
