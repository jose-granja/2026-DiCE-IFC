import { Skeleton } from "./ui/skeleton";

type LoadingProps = {
  className?: string;
};

const Loading = ({className}: LoadingProps ) => {
  return (
    <div className="relative w-full">
      <Skeleton className={className ? className : "h-[36px] w-full"} />
    </div>
  );
};

export default Loading;
