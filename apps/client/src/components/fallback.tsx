import Spinner from './spinner'

function Fallback() {
  return (
    <div className="fixed inset-0 grid place-items-center">
      <Spinner />
    </div>
  )
}

export default Fallback
