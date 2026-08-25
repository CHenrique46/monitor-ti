import { Routes, Route } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ComputerDetails from './components/ComputerDetails'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/computadores/:id" element={<ComputerDetails />} />
    </Routes>
  )
}
